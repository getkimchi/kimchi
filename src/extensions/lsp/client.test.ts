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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { getAllClients, getOrCreateClient, sendRequest, shutdownAll } from "./client.js"
import type { BunProcess, ServerConfig } from "./types.js"

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
