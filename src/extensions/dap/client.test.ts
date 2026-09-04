// extensions/dap/client.test.ts
//
// Verifies the DAP JSON-RPC client: Content-Length framing, request/response
// correlation, configurable timeout, the event pump (stopped/terminated/output),
// and shutdownAll's contract (rejects pending + kills subprocesses).
//
// Two transport modes are exercised:
//   1. An in-memory fake BunProcess (deterministic, fast) for protocol logic.
//   2. A REAL node subprocess that speaks just enough DAP to answer `initialize`,
//      used to prove shutdownAll actually reaps OS processes — not a mock.
// `afterAll` asserts every real child spawned across the file is dead.

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { BunProcess } from "../lsp/types.js"
import { DapClientRegistry, sendRequest } from "./client.js"
import type { DapAdapterConfig, DapClient } from "./types.js"

// =============================================================================
// Shared config / helpers
// =============================================================================

const FAKE_CONFIG: DapAdapterConfig = {
	name: "test-adapter",
	command: "fake-adapter",
	args: [],
	languages: ["typescript"],
	extensions: [".ts"],
	launchType: "node",
}

const CWD = "/tmp/dap-client-test"

function frame(msg: unknown): string {
	const content = JSON.stringify(msg)
	return `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`
}

function encode(s: string): Uint8Array {
	return new TextEncoder().encode(s)
}

/** Parse a single Content-Length-framed DAP message out of a write buffer. */
/** Minimal shape of a parsed DAP frame — covers request, response, and event.
 *  Widened so response/event fields (request_seq, success, message, event)
 *  are accessible without narrowing DapRequest (which only has command/args). */
interface ParsedFrame {
	seq: number
	type: "request" | "response" | "event"
	command?: string
	request_seq?: number
	success?: boolean
	message?: string
	body?: unknown
	event?: string
}

function parseOneFrame(s: string): ParsedFrame | null {
	const idx = s.indexOf("\r\n\r\n")
	if (idx === -1) return null
	return JSON.parse(s.slice(idx + 4)) as ParsedFrame
}

// =============================================================================
// In-memory fake BunProcess
// =============================================================================

interface FakeProc {
	proc: BunProcess
	written: string[]
	/** Enqueue a framed DAP message into the fake stdout so the reader pumps it. */
	enqueue: (msg: unknown) => void
	/** Enqueue raw bytes (garbage/unframed) into the fake stdout. */
	enqueueRaw: (bytes: Uint8Array) => void
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
			// Simulate process death: close the streams so reader/drain loops exit.
			try {
				stdoutController?.close()
			} catch {
				// already closed
			}
			try {
				stderrController?.close()
			} catch {
				// already closed
			}
		},
		// Never resolves on its own; only kill() ends the session.
		exited: new Promise<void>(() => {}),
		exitCode: null,
	}
	return {
		proc,
		written,
		enqueue: (msg: unknown) => {
			stdoutController?.enqueue(encode(frame(msg)))
		},
		enqueueRaw: (bytes: Uint8Array) => {
			stdoutController?.enqueue(bytes)
		},
		isKilled: () => killed,
	}
}

/** Reply to the `initialize` request the client writes on getOrCreateClient. */
async function answerInitialize(fake: FakeProc, body: unknown = { supportsTerminateRequest: true }): Promise<void> {
	// The client writes initialize synchronously inside getOrCreateClient; flush
	// one microtask to be safe before parsing the write buffer.
	await Promise.resolve()
	const initReq = parseOneFrame(fake.written[0])
	if (!initReq) throw new Error("no initialize request written")
	expect(initReq.command).toBe("initialize")
	fake.enqueue({
		seq: 1,
		type: "response",
		request_seq: initReq.seq,
		success: true,
		body,
	})
}

// =============================================================================
// Tests — in-memory protocol logic
// =============================================================================

describe("DAP client (in-memory fake adapter)", () => {
	// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
	let originalBun: any
	let fake: FakeProc
	let registry: DapClientRegistry

	beforeAll(() => {
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		originalBun = (globalThis as any).Bun
	})
	afterAll(() => {
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		;(globalThis as any).Bun = originalBun
	})

	beforeEach(() => {
		fake = createFakeProc()
		registry = new DapClientRegistry()
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		;(globalThis as any).Bun = {
			spawn: () => fake.proc,
		}
	})
	afterEach(() => {
		registry.shutdownAll()
	})

	describe("message framing and request/response correlation", () => {
		it("completes the initialize handshake and stores capabilities", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			expect(client.capabilities).not.toBeNull()
			expect(client.capabilities?.supportsTerminateRequest).toBe(true)
			expect(registry.getAll()).toHaveLength(1)
			expect(registry.getAll()[0]).toBe(client)
		})

		it("correlates a response to its request by request_seq", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			// Issue a stackTrace request; respond with the matching request_seq.
			const resultP = sendRequest(client, "stackTrace", { threadId: 1 })
			await Promise.resolve()
			const req = parseOneFrame(fake.written[1])
			if (!req) throw new Error("no stackTrace request written")
			expect(req.command).toBe("stackTrace")
			expect(req.type).toBe("request")
			fake.enqueue({
				seq: 2,
				type: "response",
				request_seq: req.seq,
				success: true,
				body: { stackFrames: [{ id: 1, name: "main", line: 5, column: 1 }] },
			})

			const result = (await resultP) as { stackFrames: Array<{ name: string }> }
			expect(result.stackFrames[0].name).toBe("main")
		})

		it("rejects when the adapter returns success:false with a message", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			const resultP = sendRequest(client, "setBreakpoints", { source: { path: "x.ts" } })
			await Promise.resolve()
			const req = parseOneFrame(fake.written[1])
			if (!req) throw new Error("no setBreakpoints request written")
			fake.enqueue({
				seq: 2,
				type: "response",
				request_seq: req.seq,
				success: false,
				message: "breakpoint could not be set",
			})

			await expect(resultP).rejects.toThrow(/setBreakpoints failed: breakpoint could not be set/)
		})
	})

	describe("timeout", () => {
		it("sendRequest times out after the configured deadline and clears the pending slot", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			await expect(sendRequest(client, "evaluate", { expression: "x" }, 50)).rejects.toThrow(/timed out after 50ms/)
			expect(client.pendingRequests.size).toBe(0)
		})
	})

	describe("event pump", () => {
		it("captures stopped events, sets threadId, and resolves stopped waiters", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			let resolved: unknown = null
			let rejected: Error | null = null
			client.stoppedWaiters.push({
				resolve: (v) => {
					resolved = v
				},
				reject: (e) => {
					rejected = e
				},
			})

			fake.enqueue({
				seq: 10,
				type: "event",
				event: "stopped",
				body: { reason: "breakpoint", threadId: 42 },
			})
			// Let the reader pump the event.
			await new Promise((r) => setTimeout(r, 10))

			expect(client.stoppedEvent?.reason).toBe("breakpoint")
			expect(client.threadId).toBe(42)
			expect(rejected).toBeNull()
			expect((resolved as { threadId: number })?.threadId).toBe(42)
		})

		it("captures terminated events and sets terminated=true, resolves waiters", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			let resolved = false
			client.terminatedWaiters.push({
				resolve: () => {
					resolved = true
				},
				reject: () => {
					/* no-op */
				},
			})

			fake.enqueue({ seq: 11, type: "event", event: "terminated", body: {} })
			await new Promise((r) => setTimeout(r, 10))

			expect(client.terminated).toBe(true)
			expect(resolved).toBe(true)
		})

		it("captures output events by category and caps the buffer at 1000 lines", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			// Enqueue 1005 output events individually. Yield periodically so the
			// reader's parse loop drains and shifts between batches, keeping the
			// fake stream's internal queue from growing unboundedly and exercising
			// the 1000-line cap (oldest entries shift out).
			for (let i = 0; i < 1005; i++) {
				fake.enqueue({
					seq: 100 + i,
					type: "event",
					event: "output",
					body: { category: "stdout", output: `l${i}\n` },
				})
				// Yield periodically so the reader can drain and shift, keeping
				// the internal queue from growing unboundedly.
				if (i % 50 === 0) await new Promise((r) => setTimeout(r, 0))
			}
			await new Promise((r) => setTimeout(r, 20))

			expect(client.outputLines.length).toBe(1000)
			expect(client.outputLines[0].category).toBe("stdout")
			expect(client.outputLines[0].text).toBe("l5\n")
		})

		it("replies success:false to server-initiated requests (e.g. runInTerminal)", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			// Server-initiated request arriving on stdout.
			fake.enqueue({
				seq: 999,
				type: "request",
				command: "runInTerminal",
				arguments: { kind: "integrated" },
			})
			await new Promise((r) => setTimeout(r, 20))

			// Find the response the client wrote back to stdin.
			const responseFrames = fake.written
				.map((w) => parseOneFrame(w))
				.filter((m): m is ParsedFrame => m !== null && m.type === "response")
			const runInTerminalResp = responseFrames.find((r) => r.request_seq === 999)
			expect(runInTerminalResp).toBeDefined()
			expect(runInTerminalResp?.success).toBe(false)
			expect(runInTerminalResp?.message).toMatch(/Unsupported server request: runInTerminal/)
			void client
		})
	})

	describe("nested-session routing (startDebugging)", () => {
		it("sendRequest routes to childClient when set", async () => {
			const childFake = createFakeProc()
			const parentClient: DapClient = {
				name: "test-parent",
				cwd: CWD,
				proc: fake.proc,
				seq: 0,
				capabilities: null,
				pendingRequests: new Map(),
				messageBuffer: Buffer.alloc(0),
				isReading: false,
				threadId: null,
				stoppedEvent: null,
				stoppedWaiters: [],
				terminatedWaiters: [],
				outputLines: [],
				terminated: false,
				initializedPromise: Promise.resolve(),
				childClient: {
					name: "test-child",
					cwd: CWD,
					proc: childFake.proc,
					seq: 100,
					capabilities: null,
					pendingRequests: new Map(),
					messageBuffer: Buffer.alloc(0),
					isReading: false,
					threadId: null,
					stoppedEvent: null,
					stoppedWaiters: [],
					terminatedWaiters: [],
					outputLines: [],
					terminated: false,
					initializedPromise: Promise.resolve(),
				},
			}

			// Send a request — it should go to the child's proc
			const resultP = sendRequest(parentClient, "stackTrace", { threadId: 1 }, 1000)
			await Promise.resolve() // let write settle

			// The child's proc should have received the request, not the parent's
			expect(childFake.written.length).toBeGreaterThan(0)
			expect(fake.written.length).toBe(0) // parent didn't receive it

			const childWritten = parseOneFrame(childFake.written[0])
			expect(childWritten?.command).toBe("stackTrace")

			// Reply from child
			childFake.enqueue({
				seq: 1,
				type: "response",
				request_seq: childWritten?.seq ?? 1,
				success: true,
				command: "stackTrace",
				body: { stackFrames: [] },
			})

			// Manually resolve the pending request (no message reader in test)
			const childClient = parentClient.childClient
			if (!childClient) throw new Error("childClient not set")
			const pending = childClient.pendingRequests.get(childWritten?.seq ?? 1)
			pending?.resolve({ stackFrames: [] })

			const result = await resultP
			expect(result).toEqual({ stackFrames: [] })
		})

		it("sendRequest falls back to parent when childClient is not set", async () => {
			const parentClient: DapClient = {
				name: "test-parent-no-child",
				cwd: CWD,
				proc: fake.proc,
				seq: 0,
				capabilities: null,
				pendingRequests: new Map(),
				messageBuffer: Buffer.alloc(0),
				isReading: false,
				threadId: null,
				stoppedEvent: null,
				stoppedWaiters: [],
				terminatedWaiters: [],
				outputLines: [],
				terminated: false,
				initializedPromise: Promise.resolve(),
			}

			const resultP = sendRequest(parentClient, "threads", {}, 1000)
			await Promise.resolve()

			// The parent's proc should have received the request
			expect(fake.written.length).toBeGreaterThan(0)
			const parentWritten = parseOneFrame(fake.written[0])
			expect(parentWritten?.command).toBe("threads")

			// Manually resolve the pending request
			const pending = parentClient.pendingRequests.get(parentWritten?.seq ?? 1)
			pending?.resolve({ threads: [{ id: 1, name: "main" }] })

			const result = await resultP
			expect(result).toEqual({ threads: [{ id: 1, name: "main" }] })
		})

		it("startDebugging handler replies success and is not treated as unsupported", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			await clientPromise

			fake.enqueue({
				seq: 500,
				type: "request",
				command: "startDebugging",
				arguments: {
					request: "launch",
					configuration: { type: "pwa-node", name: "test" },
				},
			})
			await new Promise((r) => setTimeout(r, 50))

			const responses = fake.written
				.map((w) => parseOneFrame(w))
				.filter((m) => m?.type === "response" && m?.request_seq === 500)
			const startDbgResp = responses[0]
			expect(startDbgResp).toBeDefined()
			// The handler should reply success:true for stdio adapters
			expect(startDbgResp?.success).toBe(true)
		})
	})

	describe("message buffer cap", () => {
		it("rejects pending requests when the adapter floods >10MB of unframed bytes", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			// Start a request that will never be answered; long timeout so only
			// the buffer-cap path can end it.
			const pending = sendRequest(client, "evaluate", { expression: "y" }, 30_000)
			await Promise.resolve()
			expect(client.pendingRequests.size).toBe(1)

			// 10MB+1 of zero bytes — no DAP framing, parseMessage keeps buffering.
			fake.enqueueRaw(new Uint8Array(10 * 1024 * 1024 + 1))

			await expect(pending).rejects.toThrow(/protocol garbage/)
			expect(client.pendingRequests.size).toBe(0)
		})
	})

	describe("shutdownAll", () => {
		it("rejects pending requests and kills the subprocess", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			// Start a request that will never be answered; long timeout so only
			// shutdownAll ends it.
			const pending = sendRequest(client, "evaluate", { expression: "y" }, 30_000)
			await Promise.resolve()
			expect(client.pendingRequests.size).toBe(1)

			registry.shutdownAll()

			await expect(pending).rejects.toThrow(/DAP shutdown/)
			expect(fake.isKilled()).toBe(true)
			expect(registry.getAll()).toHaveLength(0)
			expect(client.terminated).toBe(true)
		})

		it("rejects outstanding stop/terminate waiters", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			const stopWaiter = { resolve: vi.fn(), reject: vi.fn() }
			client.stoppedWaiters.push(stopWaiter)

			registry.shutdownAll()

			expect(stopWaiter.reject).toHaveBeenCalledOnce()
		})

		it("rejects stop/terminate waiters fast when the adapter process dies", async () => {
			const clientPromise = registry.getOrCreate(FAKE_CONFIG, CWD)
			await answerInitialize(fake)
			const client = await clientPromise

			const stopWaiter = { resolve: vi.fn(), reject: vi.fn() }
			const termWaiter = { resolve: vi.fn(), reject: vi.fn() }
			client.stoppedWaiters.push(stopWaiter)
			client.terminatedWaiters.push(termWaiter)

			// Kill closes the fake's streams; the reader loop ends and must fail
			// outstanding waiters immediately rather than letting them time out.
			fake.proc.kill()
			await new Promise((resolve) => setTimeout(resolve, 0))

			expect(stopWaiter.reject).toHaveBeenCalledOnce()
			expect(stopWaiter.reject.mock.calls[0]?.[0].message).toMatch(/DAP connection closed/)
			expect(termWaiter.reject).toHaveBeenCalledOnce()
		})
	})

	describe("session-scoped client keys", () => {
		it("getOrCreate with different scopes spawns isolated clients", async () => {
			const fakes = [createFakeProc(), createFakeProc()]
			let spawnCount = 0
			// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
			;(globalThis as any).Bun = {
				spawn: () => fakes[spawnCount++]?.proc,
			}

			const p1 = registry.getOrCreate(FAKE_CONFIG, CWD, "session-1")
			const p2 = registry.getOrCreate(FAKE_CONFIG, CWD, "session-2")
			await answerInitialize(fakes[0] as FakeProc)
			await answerInitialize(fakes[1] as FakeProc)
			const [c1, c2] = await Promise.all([p1, p2])

			expect(c1).not.toBe(c2)
			expect(registry.getAll()).toHaveLength(2)

			// Killing one session's client (what DapSession.terminate does) leaves
			// the other session's client untouched — no cross-kill.
			const k1 = fakes[0] as FakeProc
			const k2 = fakes[1] as FakeProc
			k1.proc.kill()
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(k2.isKilled()).toBe(false)
		})

		it("getOrCreate with the same scope dedupes to one client", async () => {
			const p1 = registry.getOrCreate(FAKE_CONFIG, CWD, "session-1")
			const p2 = registry.getOrCreate(FAKE_CONFIG, CWD, "session-1")
			await answerInitialize(fake)
			const [c1, c2] = await Promise.all([p1, p2])

			expect(c1).toBe(c2)
			expect(registry.getAll()).toHaveLength(1)
		})
	})
})

// =============================================================================
// Real-subprocess leak test (genuine OS-level verification)
// =============================================================================

const ECHO_ADAPTER_SCRIPT = String.raw`
const { Buffer } = require('buffer');
let buf = Buffer.alloc(0);
function tryParse() {
  while (true) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) break;
    const header = buf.slice(0, idx).toString();
    const m = header.match(/Content-Length: (\d+)/);
    if (!m) { buf = buf.slice(idx + 4); continue; }
    const len = parseInt(m[1], 10);
    const start = idx + 4;
    if (buf.length < start + len) break;
    const msg = JSON.parse(buf.slice(start, start + len).toString());
    buf = buf.slice(start + len);
    if (msg.type === 'request' && msg.command === 'initialize') {
      const resp = { seq: 1, type: 'response', request_seq: msg.seq, success: true, body: { supportsTerminateRequest: true } };
      const content = JSON.stringify(resp);
      process.stdout.write('Content-Length: ' + Buffer.byteLength(content) + '\r\n\r\n' + content);
    }
  }
}
process.stdin.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); tryParse(); });
setInterval(() => {}, 60000);
`

/** A BunProcess backed by a real child_process.spawn — used to prove kills reap
 *  real OS processes, not mock state. */
function realBunSpawn(args: string[], opts: { cwd: string }): BunProcess {
	const [cmd, ...rest] = args
	const child = nodeSpawn(cmd, rest, {
		cwd: opts.cwd,
		stdio: ["pipe", "pipe", "pipe"],
	})
	const proc: BunProcess = {
		stdin: {
			write(data: Uint8Array | string) {
				child.stdin.write(data as Buffer | string)
			},
			flush() {
				return Promise.resolve()
			},
			end() {
				child.stdin.end()
			},
		},
		stdout: Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
		stderr: Readable.toWeb(child.stderr as Readable) as ReadableStream<Uint8Array>,
		kill() {
			child.kill("SIGKILL")
		},
		exited: new Promise<void>((resolve) => {
			child.on("exit", () => resolve())
		}),
		exitCode: null,
	}
	child.on("exit", (code) => {
		proc.exitCode = code
	})
	// Stash the child on the proc so the test can inspect the pid.
	;(proc as unknown as { child: ChildProcess }).child = child
	return proc
}

async function waitForProcessExit(pid: number, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0)
		} catch {
			return true // ESRCH — process is gone
		}
		await new Promise((r) => setTimeout(r, 20))
	}
	return false // still alive
}

describe("DAP client shutdown kills real subprocesses (no leaks)", () => {
	const realChildren: ChildProcess[] = []
	// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
	let originalBun: any
	let tmpScript: string
	let registry: DapClientRegistry

	beforeAll(() => {
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		originalBun = (globalThis as any).Bun
		tmpScript = path.join(os.tmpdir(), `dap-echo-${process.pid}-${Date.now()}.js`)
		fs.writeFileSync(tmpScript, ECHO_ADAPTER_SCRIPT)
		registry = new DapClientRegistry()
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		;(globalThis as any).Bun = {
			spawn: (args: string[], opts: { cwd: string }) => {
				const proc = realBunSpawn(args, opts)
				const child = (proc as unknown as { child: ChildProcess }).child
				realChildren.push(child)
				return proc
			},
		}
	})

	afterAll(async () => {
		// Restore so other test files see the original environment.
		// biome-ignore lint/suspicious/noExplicitAny: Bun global is untyped in tests
		;(globalThis as any).Bun = originalBun
		registry.shutdownAll()

		// The "process-count assertion": every real child spawned across this
		// describe block must be dead — no leaked subprocesses.
		let leaked = 0
		for (const child of realChildren) {
			if (child.pid == null) continue
			const exited = await waitForProcessExit(child.pid, 2000)
			if (!exited) leaked++
		}
		expect(leaked).toBe(0)

		try {
			fs.unlinkSync(tmpScript)
		} catch {
			// already gone
		}
	})

	it("completes initialize against a real node echo adapter, then shutdownAll reaps it", async () => {
		const config: DapAdapterConfig = {
			name: "node-echo",
			command: process.execPath, // node binary
			args: [tmpScript],
			languages: ["typescript"],
			extensions: [".ts"],
			launchType: "node",
		}
		const client = await registry.getOrCreate(config, os.tmpdir())
		expect(client.capabilities?.supportsTerminateRequest).toBe(true)
		expect(registry.getAll()).toHaveLength(1)

		// Capture the child pid before shutdown.
		const child = (client.proc as unknown as { child: ChildProcess }).child
		expect(child.pid).toBeTruthy()
		const pid = child.pid as number

		// Process should be alive right now.
		expect(() => process.kill(pid, 0)).not.toThrow()

		registry.shutdownAll()

		// The real subprocess must be gone after shutdownAll.
		const exited = await waitForProcessExit(pid, 2000)
		expect(exited).toBe(true)
		expect(() => process.kill(pid, 0)).toThrow()
		expect(registry.getAll()).toHaveLength(0)
	})
})

describe("missing adapter binary", () => {
	it("rejects getOrCreate quickly with a spawn error — no crash, no 30s hang", async () => {
		const registry = new DapClientRegistry()
		const missingConfig: DapAdapterConfig = {
			name: "missing-adapter",
			command: "definitely-missing-dap-bin-xyz-abc123",
			args: [],
			languages: ["typescript"],
			extensions: [".ts"],
			launchType: "node",
			transport: { kind: "stdio" },
		}
		const start = Date.now()
		// Without a cp.on("error") listener this would be an uncaught exception;
		// without 'close'-based exited tracking it would hang until the 30s
		// initialize timeout.
		await expect(registry.getOrCreate(missingConfig, os.tmpdir())).rejects.toThrow(/DAP adapter/)
		expect(Date.now() - start).toBeLessThan(20_000)
		// The failed client must not linger in the registry.
		expect(registry.getAll()).toHaveLength(0)
		registry.shutdownAll()
	}, 30_000)
})
