// extensions/lsp/client.test.ts
//
// Regression tests for the LSP JSON-RPC message reader.
//
// The core bug: when the server emitted a valid-JSON but non-object frame
// (e.g. bare `null`, a number) or an unparseable body, `JSON.parse` either
// returned a primitive (causing `"id" in message` to throw TypeError) or threw
// directly. The thrown error propagated to the reader's catch block, which
// rejected all pending requests and left a zombie client in the registry —
// every subsequent LSP operation then failed with timeouts.
//
// These tests verify:
//   1. Non-object frames (bare null, number) are skipped — reader survives.
//   2. Unparseable JSON frames are skipped — reader survives.
//   3. Valid frames after skipped ones still process.
//   4. On reader crash, the zombie client is removed from the registry.
//
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
	ensureFileOpen,
	getAllClients,
	getOrCreateClient,
	reapIdleClients,
	refreshFile,
	sendRequest,
	shutdownAll,
} from "./client.js"
import {
	LSP_EVICT_GRACE_MS,
	LSP_IDLE_EVICT_MS,
	LSP_REAPER_SWEEP_MS,
	MAX_CHAINS,
	OPEN_DOCS_MAX,
} from "./lifecycle-constants.js"
import type { BunProcess, ServerConfig } from "./types.js"
import { fileToUri } from "./utils.js"

// =============================================================================
// Helpers
// =============================================================================

const CWD = "/tmp/lsp-client-test"

const FAKE_CONFIG: ServerConfig = {
	name: "typescript-language-server",
	command: "typescript-language-server",
	args: ["--stdio"],
	extensions: ["ts"],
}

function frame(msg: unknown): string {
	const content = JSON.stringify(msg)
	return `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`
}

/** Frame a raw string body (for invalid JSON or non-object payloads). */
function frameRaw(content: string): string {
	return `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`
}

function encode(s: string): Uint8Array {
	return new TextEncoder().encode(s)
}

interface FakeProc {
	proc: BunProcess
	written: string[]
	enqueue: (msg: unknown) => void
	enqueueRaw: (content: string) => void
	closeStdout: () => void
	errorStdout: (err: Error) => void
	isKilled: () => boolean
}

function createFakeProc(): FakeProc {
	let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null
	let stderrController: ReadableStreamDefaultController<Uint8Array> | null = null
	const stdout = new ReadableStream<Uint8Array>({
		start(c) {
			stdoutController = c
		},
	})
	const stderr = new ReadableStream<Uint8Array>({
		start(c) {
			stderrController = c
		},
	})
	const written: string[] = []
	let killed = false
	const proc: BunProcess = {
		stdin: {
			write(data: Uint8Array | string) {
				written.push(typeof data === "string" ? data : Buffer.from(data).toString())
			},
			flush() {
				return Promise.resolve()
			},
			end() {
				/* no-op */
			},
		},
		stdout,
		stderr,
		kill() {
			killed = true
			try {
				stdoutController?.close()
			} catch {
				/* already closed */
			}
			try {
				stderrController?.close()
			} catch {
				/* already closed */
			}
		},
		exited: new Promise<void>(() => {}),
		exitCode: null,
	}
	return {
		proc,
		written,
		enqueue: (msg: unknown) => {
			stdoutController?.enqueue(encode(frame(msg)))
		},
		enqueueRaw: (content: string) => {
			stdoutController?.enqueue(encode(frameRaw(content)))
		},
		closeStdout: () => {
			try {
				stdoutController?.close()
			} catch {
				/* already closed */
			}
		},
		errorStdout: (err: Error) => {
			try {
				stdoutController?.error(err)
			} catch {
				/* already closed */
			}
		},
		isKilled: () => killed,
	}
}

/** Parse the initialize request the client writes on getOrCreateClient. */
function parseWrittenRequest(s: string): { id: number; method: string } | null {
	const idx = s.indexOf("\r\n\r\n")
	if (idx === -1) return null
	try {
		return JSON.parse(s.slice(idx + 4))
	} catch {
		return null
	}
}

/**
 * Complete the initialize handshake so getOrCreateClient can resolve.
 * Must be called concurrently with the getOrCreateClient promise — the
 * client writes the initialize request synchronously inside getOrCreateClient,
 * but awaits the response + projectLoaded promise before returning.
 *
 * Usage:
 *   const clientPromise = getOrCreateClient(FAKE_CONFIG, CWD)
 *   await answerInitialize(fake)
 *   const client = await clientPromise
 */
async function answerInitialize(fake: FakeProc): Promise<void> {
	await Promise.resolve()
	await Promise.resolve()
	const initReq = parseWrittenRequest(fake.written[0])
	if (!initReq) throw new Error("no initialize request written")

	// Respond to initialize
	fake.enqueue({ jsonrpc: "2.0", id: initReq.id, result: { capabilities: {} } })
	// Resolve projectLoaded via $/progress end with empty token set
	fake.enqueue({
		jsonrpc: "2.0",
		method: "$/progress",
		params: { token: "test", value: { kind: "end" } },
	})
}

// =============================================================================
// Tests
// =============================================================================

// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
let originalBun: any

beforeAll(() => {
	// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
	originalBun = (globalThis as any).Bun
})

afterAll(() => {
	// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
	;(globalThis as any).Bun = originalBun
})

afterEach(() => {
	vi.restoreAllMocks()
	shutdownAll()
})

describe("LSP client reader — malformed frame resilience", () => {
	let fake: FakeProc

	beforeEach(() => {
		fake = createFakeProc()
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		;(globalThis as any).Bun = {
			spawn: () => fake.proc,
		}
	})

	it("skips a bare null frame and continues processing valid frames", async () => {
		const clientPromise = getOrCreateClient(FAKE_CONFIG, CWD)
		await answerInitialize(fake)
		const client = await clientPromise

		// Enqueue a bare `null` (valid JSON, non-object) — this used to crash
		// the reader via `"id" in null` TypeError.
		fake.enqueueRaw("null")

		// Enqueue a valid publishDiagnostics notification — reader must still
		// be alive to process it.
		const uri = "file:///tmp/lsp-client-test/foo.ts"
		fake.enqueue({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: {
				uri,
				diagnostics: [
					{
						message: "test error",
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
						severity: 1,
					},
				],
			},
		})

		// Give the reader a moment to process
		await new Promise((r) => setTimeout(r, 200))

		// Reader survived — diagnostics were stored
		const entry = client.diagnostics.get(uri)
		expect(entry).toBeDefined()
		expect(entry?.diagnostics).toHaveLength(1)
		expect(entry?.diagnostics[0].message).toBe("test error")
	})

	it("skips a bare number frame and continues processing valid frames", async () => {
		const clientPromise = getOrCreateClient(FAKE_CONFIG, CWD)
		await answerInitialize(fake)
		const client = await clientPromise

		// Bare number — `typeof 42 !== "object"` → skipped
		fake.enqueueRaw("42")

		const uri = "file:///tmp/lsp-client-test/bar.ts"
		fake.enqueue({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri, diagnostics: [] },
		})

		await new Promise((r) => setTimeout(r, 200))

		// Reader survived — empty diagnostics entry was stored
		expect(client.diagnostics.has(uri)).toBe(true)
		expect(client.diagnostics.get(uri)?.diagnostics).toHaveLength(0)
	})

	it("skips an unparseable JSON frame and continues processing valid frames", async () => {
		const clientPromise = getOrCreateClient(FAKE_CONFIG, CWD)
		await answerInitialize(fake)
		const client = await clientPromise

		// Invalid JSON body
		fake.enqueueRaw("{not valid json}")

		const uri = "file:///tmp/lsp-client-test/baz.ts"
		fake.enqueue({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: {
				uri,
				diagnostics: [
					{ message: "after garbage", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
				],
			},
		})

		await new Promise((r) => setTimeout(r, 200))

		// Reader survived — diagnostics were stored
		const entry = client.diagnostics.get(uri)
		expect(entry).toBeDefined()
		expect(entry?.diagnostics[0].message).toBe("after garbage")
	})

	it("processes multiple valid frames interleaved with malformed ones", async () => {
		// Raw console writes corrupt the interactive TUI — the skip path must
		// route through debuglog ("kimchi:lsp"), never console.error.
		const consoleSpy = vi.spyOn(console, "error")
		const clientPromise = getOrCreateClient(FAKE_CONFIG, CWD)
		await answerInitialize(fake)
		const client = await clientPromise

		const uri1 = "file:///tmp/lsp-client-test/a.ts"
		const uri2 = "file:///tmp/lsp-client-test/b.ts"

		// Valid → garbage → valid → non-object → valid
		fake.enqueue({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: uri1, diagnostics: [] } })
		fake.enqueueRaw("garbage content")
		fake.enqueue({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: uri2, diagnostics: [] } })
		fake.enqueueRaw("null")
		fake.enqueue({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: {
				uri: uri1,
				diagnostics: [
					{ message: "updated", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
				],
			},
		})

		await new Promise((r) => setTimeout(r, 300))

		// All three valid frames were processed; garbage and null were skipped
		expect(client.diagnostics.get(uri1)?.diagnostics[0].message).toBe("updated")
		expect(client.diagnostics.has(uri2)).toBe(true)
		expect(consoleSpy).not.toHaveBeenCalled()
	})
})

describe("LSP client reader — zombie cleanup on crash", () => {
	let fake: FakeProc

	beforeEach(() => {
		fake = createFakeProc()
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		;(globalThis as any).Bun = {
			spawn: () => fake.proc,
		}
	})

	it("removes the client from the registry when the reader crashes", async () => {
		const clientPromise = getOrCreateClient(FAKE_CONFIG, CWD)
		await answerInitialize(fake)
		const client = await clientPromise

		// Verify client is registered
		expect(getAllClients()).toHaveLength(1)

		// Start a pending request so we can verify it gets rejected
		const requestPromise = sendRequest(client, "textDocument/hover", {}).catch(() => "rejected")

		// Crash the reader by erroring the stdout stream
		fake.errorStdout(new Error("simulated stream error"))

		// Wait for the rejection to propagate
		const result = await Promise.race([
			requestPromise,
			new Promise<string>((r) => setTimeout(() => r("timeout"), 2000)),
		])

		expect(result).toBe("rejected")

		// Give the catch block a moment to clean up
		await new Promise((r) => setTimeout(r, 100))

		// Zombie client should be removed — next getOrCreateClient would spawn fresh
		expect(getAllClients()).toHaveLength(0)
		// Process should have been killed
		expect(fake.isKilled()).toBe(true)
	})
})

describe("openFiles LRU bound", () => {
	let fake: FakeProc

	beforeEach(() => {
		fake = createFakeProc()
		// ensureFileOpen/refreshFile read file contents via Bun.file — stub it
		// alongside spawn so no real filesystem access happens.
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		;(globalThis as any).Bun = {
			spawn: () => fake.proc,
			file: (p: string) => ({ text: async () => `// content of ${p}` }),
		}
	})

	async function makeClient() {
		const clientPromise = getOrCreateClient(FAKE_CONFIG, CWD)
		await answerInitialize(fake)
		return clientPromise
	}

	it("evicts the least-recently-opened document beyond OPEN_DOCS_MAX with didClose", async () => {
		const client = await makeClient()
		const overflow = 5
		for (let i = 0; i < OPEN_DOCS_MAX + overflow; i++) {
			await ensureFileOpen(client, `${CWD}/f${i}.ts`)
		}

		expect(client.openFiles.size).toBe(OPEN_DOCS_MAX)
		// The first `overflow` documents are the ones evicted.
		for (let i = 0; i < overflow; i++) {
			expect(client.openFiles.has(fileToUri(`${CWD}/f${i}.ts`))).toBe(false)
		}
		for (let i = overflow; i < OPEN_DOCS_MAX + overflow; i++) {
			expect(client.openFiles.has(fileToUri(`${CWD}/f${i}.ts`))).toBe(true)
		}
		// Each eviction notified the server with didClose.
		const didCloses = fake.written.filter((w) => w.includes('"textDocument/didClose"'))
		expect(didCloses).toHaveLength(overflow)
		expect(didCloses[0]).toContain(fileToUri(`${CWD}/f0.ts`))
	})

	it("drops cached diagnostics when a document is evicted", async () => {
		const client = await makeClient()
		const evictedUri = fileToUri(`${CWD}/f0.ts`)
		await ensureFileOpen(client, `${CWD}/f0.ts`)
		client.diagnostics.set(evictedUri, {
			diagnostics: [
				{ message: "old diag", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
			],
			version: 1,
		})
		for (let i = 1; i <= OPEN_DOCS_MAX; i++) {
			await ensureFileOpen(client, `${CWD}/f${i}.ts`)
		}

		expect(client.openFiles.has(evictedUri)).toBe(false)
		expect(client.diagnostics.has(evictedUri)).toBe(false)
	})

	it("refreshFile bumps recency so a refreshed document survives eviction", async () => {
		const client = await makeClient()
		for (let i = 0; i < OPEN_DOCS_MAX; i++) {
			await ensureFileOpen(client, `${CWD}/f${i}.ts`)
		}
		// Refreshing f0 makes it the most-recently-used document.
		await refreshFile(client, `${CWD}/f0.ts`)
		// Opening one more forces exactly one eviction: f1 (the new oldest),
		// not f0 (just refreshed).
		await ensureFileOpen(client, `${CWD}/new.ts`)

		expect(client.openFiles.has(fileToUri(`${CWD}/f0.ts`))).toBe(true)
		expect(client.openFiles.has(fileToUri(`${CWD}/f1.ts`))).toBe(false)
		expect(client.openFiles.size).toBe(OPEN_DOCS_MAX)
	})
})

describe("chain cap (MAX_CHAINS)", () => {
	const fakes: FakeProc[] = []

	beforeEach(() => {
		fakes.length = 0
		// One fake proc per spawn so each chain can be asserted on separately.
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		;(globalThis as any).Bun = {
			spawn: () => {
				const f = createFakeProc()
				fakes.push(f)
				return f.proc
			},
		}
	})

	async function makeClientAt(cwd: string) {
		// Bun.spawn runs synchronously inside getOrCreateClient, so the fake
		// for this chain is appended to `fakes` before the promise returns.
		const spawnIndex = fakes.length
		const clientPromise = getOrCreateClient(FAKE_CONFIG, cwd)
		await answerInitialize(fakes[spawnIndex])
		return clientPromise
	}

	it("spawning past MAX_CHAINS evicts the least-recently-active idle chain", async () => {
		vi.useFakeTimers()
		try {
			const a = await makeClientAt(`${CWD}/a`)
			const b = await makeClientAt(`${CWD}/b`)
			// A is the oldest by far; B recent.
			a.lastActivity = 1_000
			b.lastActivity = 2_000

			await makeClientAt(`${CWD}/c`)

			// Registry converges back to MAX_CHAINS: A evicted, B and C live.
			expect(
				getAllClients()
					.map((cl) => cl.cwd)
					.sort(),
			).toEqual([`${CWD}/b`, `${CWD}/c`])
			// Eviction rejects nothing (A had no pending requests) and kills A's
			// process after the grace timer — B and C stay alive.
			expect(fakes[0].isKilled()).toBe(false)
			vi.advanceTimersByTime(LSP_EVICT_GRACE_MS + 100)
			expect(fakes[0].isKilled()).toBe(true)
			expect(fakes[1].isKilled()).toBe(false)
			expect(fakes[2].isKilled()).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it("never evicts a chain with in-flight requests; exceeds the cap instead", async () => {
		const a = await makeClientAt(`${CWD}/a`)
		const b = await makeClientAt(`${CWD}/b`)
		a.lastActivity = 1_000
		b.lastActivity = 2_000
		// Both chains are busy — their hover requests are never answered.
		const busyA = sendRequest(a, "textDocument/hover", {}).catch(() => "rejected")
		const busyB = sendRequest(b, "textDocument/hover", {}).catch(() => "rejected")

		await makeClientAt(`${CWD}/c`)

		// No eviction: all three chains live, cap exceeded temporarily.
		expect(getAllClients()).toHaveLength(MAX_CHAINS + 1)
		expect(fakes[0].isKilled()).toBe(false)
		expect(fakes[1].isKilled()).toBe(false)
		// Cleanup settles the dangling requests.
		shutdownAll()
		await busyA
		await busyB
	})
})

describe("idle client reaper", () => {
	let fake: FakeProc

	beforeEach(() => {
		fake = createFakeProc()
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		;(globalThis as any).Bun = {
			spawn: () => fake.proc,
		}
	})

	async function makeClient() {
		const clientPromise = getOrCreateClient(FAKE_CONFIG, CWD)
		await answerInitialize(fake)
		return clientPromise
	}

	it("reaps only chains idle past the threshold", async () => {
		const client = await makeClient()
		client.lastActivity = 1_000_000
		const evicted: string[] = []
		const now = 1_000_000 + LSP_IDLE_EVICT_MS

		// Idle exactly at the threshold → reaped.
		expect(reapIdleClients(now, LSP_IDLE_EVICT_MS, (c) => void evicted.push(c.name))).toBe(1)
		expect(evicted).toEqual([client.name])

		// Recent activity → kept.
		client.lastActivity = now
		expect(reapIdleClients(now + 1000, LSP_IDLE_EVICT_MS, (c) => void evicted.push(c.name))).toBe(0)
	})

	it("never reaps a chain with in-flight requests or diagnostic waiters", async () => {
		const client = await makeClient()
		client.lastActivity = 0 // ancient

		client.pendingRequests.set(1, { resolve: () => {}, reject: () => {}, method: "textDocument/hover" })
		expect(reapIdleClients(Date.now(), LSP_IDLE_EVICT_MS, () => {})).toBe(0)
		client.pendingRequests.clear()

		const uri = fileToUri(`${CWD}/waited.ts`)
		client.diagnosticWaiters.set(uri, new Set([{ snapshot: 0, resolve: () => {} }]))
		expect(reapIdleClients(Date.now(), LSP_IDLE_EVICT_MS, () => {})).toBe(0)
		client.diagnosticWaiters.clear()

		expect(reapIdleClients(Date.now(), LSP_IDLE_EVICT_MS, () => {})).toBe(1)
	})

	it("sweeps an idle chain end-to-end: reaped at the threshold, killed after grace", async () => {
		vi.useFakeTimers()
		try {
			await makeClient()
			expect(getAllClients()).toHaveLength(1)

			// 14 minutes idle: every sweep keeps the chain (threshold is 15).
			vi.advanceTimersByTime(LSP_IDLE_EVICT_MS - LSP_REAPER_SWEEP_MS)
			expect(getAllClients()).toHaveLength(1)
			expect(fake.isKilled()).toBe(false)

			// Past the threshold: the next sweep reaps, the grace timer kills.
			vi.advanceTimersByTime(2 * LSP_REAPER_SWEEP_MS + LSP_EVICT_GRACE_MS + 1_000)
			expect(getAllClients()).toHaveLength(0)
			expect(fake.isKilled()).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	it("keeps an active chain alive across sweeps", async () => {
		vi.useFakeTimers()
		try {
			const client = await makeClient()
			for (let i = 0; i < 5; i++) {
				// Simulate periodic tool activity: never idle for a full threshold.
				vi.advanceTimersByTime(LSP_IDLE_EVICT_MS - 60_000)
				client.lastActivity = Date.now()
			}
			expect(getAllClients()).toHaveLength(1)
			expect(fake.isKilled()).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})
})
