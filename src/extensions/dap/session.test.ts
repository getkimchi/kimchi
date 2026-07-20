// extensions/dap/session.test.ts
//
// Verifies DapSession's per-session debug state and primitive operations
// against an in-memory mock DapClient (no subprocess). The real `sendRequest`
// from ./client.js is replaced via vi.mock so session.ts's import is
// intercepted — the mock captures every command/args and returns queued canned
// responses (FIFO per command). vi.hoisted() lifts the mock state above the
// vi.mock call (which is itself hoisted above imports).
//
// Tests cover:
//   - launch sends `launch` then `configurationDone` (when supported)
//   - setBreakpoint tracks per-file breakpoints and resends the full set
//   - continue/stepIn/stepOver/stepOut register a stop waiter BEFORE the
//     request, then resolve with the StoppedEvent (race-safe)
//   - getStackFrame/getScopes/getVariables/evaluate delegate to the client
//   - terminate is best-effort (terminate request + kill) and idempotent
//   - session registry (createSession/getSession/removeSession/getActiveSessions)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { BunProcess } from "../lsp/types.js"
import type {
	DapAdapterConfig,
	DapCapabilities,
	DapClient,
	DapEvaluateResult,
	Scope,
	StackFrame,
	StoppedEvent,
	TerminatedEvent,
	Variable,
} from "./types.js"

// =============================================================================
// Mock state — hoisted above vi.mock so the factory can reference it
// =============================================================================

interface CapturedRequest {
	command: string
	args: unknown
}

const { captured, queued } = vi.hoisted(() => ({
	captured: [] as CapturedRequest[],
	queued: new Map<string, Array<{ body: unknown; success: boolean }>>(),
}))

vi.mock("./client.js", () => ({
	sendRequest: vi.fn(async (_client: unknown, command: string, args: unknown) => {
		captured.push({ command, args })
		const arr = queued.get(command)
		if (!arr || arr.length === 0) {
			throw new Error(`no queued response for ${command}`)
		}
		const { body, success } = arr.shift() as { body: unknown; success: boolean }
		if (!success) throw new Error(`DAP ${command} failed`)
		return body
	}),
}))

// Import AFTER vi.mock so session.ts picks up the mocked sendRequest.
const { clearAllSessions, createSession, getActiveSessions, getSession, removeSession } = await import("./session.js")

import type { DapSessionOptions } from "./session.js"

// =============================================================================
// Mock DapClient — satisfies the DapClient interface without a subprocess
// =============================================================================

interface MockClient extends DapClient {
	/** Inject a DAP event (stopped/terminated) into the session's waiters. */
	emitEvent(event: "stopped" | "terminated", body: unknown): void
}

function createMockClient(capabilities: DapCapabilities | null = null): MockClient {
	const stoppedWaiters: DapClient["stoppedWaiters"] = []
	const terminatedWaiters: DapClient["terminatedWaiters"] = []

	const fakeProc: BunProcess = {
		stdin: { write: () => {}, flush: () => Promise.resolve(), end: () => {} },
		stdout: new ReadableStream<Uint8Array>(),
		stderr: new ReadableStream<Uint8Array>(),
		kill: () => {},
		exited: new Promise<void>(() => {}),
		exitCode: null,
	}

	return {
		name: "test-adapter",
		cwd: CWD,
		proc: fakeProc,
		seq: 0,
		capabilities,
		pendingRequests: new Map(),
		messageBuffer: Buffer.alloc(0),
		isReading: false,
		lastActivity: Date.now(),
		threadId: null,
		stoppedEvent: null,
		stoppedWaiters,
		terminatedWaiters,
		outputLines: [],
		terminated: false,
		emitEvent(event, body) {
			if (event === "stopped") {
				for (const w of stoppedWaiters) w.resolve(body as StoppedEvent)
				stoppedWaiters.length = 0
			} else if (event === "terminated") {
				this.terminated = true
				for (const w of terminatedWaiters) w.resolve(body as TerminatedEvent)
				terminatedWaiters.length = 0
			}
		},
	}
}

// =============================================================================
// Shared config + helpers
// =============================================================================

const FAKE_CONFIG: DapAdapterConfig = {
	name: "test-adapter",
	command: "fake-adapter",
	args: [],
	languages: ["typescript"],
	extensions: [".ts"],
	launchType: "node",
}

const CWD = "/tmp/dap-session-test"

function makeSession(client: MockClient): ReturnType<typeof createSession> {
	const opts: DapSessionOptions = { adapter: FAKE_CONFIG, cwd: CWD, client }
	return createSession(opts)
}

function queueResponse(command: string, body: unknown, success = true): void {
	const arr = queued.get(command) ?? []
	arr.push({ body, success })
	queued.set(command, arr)
}

// =============================================================================
// Tests
// =============================================================================

describe("DapSession", () => {
	beforeEach(() => {
		clearAllSessions()
		captured.length = 0
		queued.clear()
	})
	afterEach(() => {
		clearAllSessions()
		captured.length = 0
		queued.clear()
	})

	describe("launch", () => {
		it("launch sends `launch` (fire-and-forget); completeLaunch sends configurationDone when supported", async () => {
			const client = createMockClient({ supportsConfigurationDoneRequest: true } as DapCapabilities)
			const session = makeSession(client)
			queueResponse("launch", {})
			queueResponse("configurationDone", {})

			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			expect(session.isLaunched).toBe(true)
			// launch() fires the request without awaiting; only `launch` is captured so far
			expect(captured.map((r) => r.command)).toEqual(["launch"])
			const launchArgs = captured[0].args as { program: string; stopOnEntry: boolean }
			expect(launchArgs.program).toBe("/tmp/app.js")
			expect(launchArgs.stopOnEntry).toBe(false)

			await session.completeLaunch()
			expect(captured.map((r) => r.command)).toEqual(["launch", "configurationDone"])
		})

		it("completeLaunch skips configurationDone when unsupported but awaits launch response", async () => {
			const client = createMockClient({ supportsConfigurationDoneRequest: false } as DapCapabilities)
			const session = makeSession(client)
			queueResponse("launch", {})

			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			expect(captured.map((r) => r.command)).toEqual(["launch"])
			await session.completeLaunch()
			expect(captured.map((r) => r.command)).toEqual(["launch"]) // no configurationDone
		})

		it("completeLaunch is idempotent", async () => {
			const client = createMockClient({ supportsConfigurationDoneRequest: true } as DapCapabilities)
			const session = makeSession(client)
			queueResponse("launch", {})
			queueResponse("configurationDone", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			await session.completeLaunch()
			await session.completeLaunch() // second call is a no-op
			expect(captured.filter((r) => r.command === "configurationDone")).toHaveLength(1)
		})

		it("throws if launched twice", async () => {
			const client = createMockClient({ supportsConfigurationDoneRequest: false } as DapCapabilities)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })

			await expect(session.launch({ program: "/tmp/app.js", cwd: CWD })).rejects.toThrow("already launched")
		})
	})

	describe("setBreakpoint", () => {
		it("sends setBreakpoints with the new breakpoint and returns verified status", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })

			queueResponse("setBreakpoints", {
				breakpoints: [{ verified: true, line: 10, id: 1 }],
			})
			const bp = await session.setBreakpoint("/tmp/app.js", 10)
			expect(bp.verified).toBe(true)
			expect(bp.line).toBe(10)

			const args = captured.at(-1)?.args as {
				source: { path: string }
				breakpoints: Array<{ line: number; condition?: string }>
				lines: number[]
			}
			expect(args.source.path).toBe("/tmp/app.js")
			expect(args.breakpoints).toHaveLength(1)
			expect(args.breakpoints[0].line).toBe(10)
			expect(args.lines).toEqual([10])
		})

		it("resends the full set when adding a second breakpoint to the same file", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })

			queueResponse("setBreakpoints", { breakpoints: [{ verified: true, line: 10 }] })
			await session.setBreakpoint("/tmp/app.js", 10)

			queueResponse("setBreakpoints", {
				breakpoints: [
					{ verified: true, line: 10 },
					{ verified: true, line: 20 },
				],
			})
			await session.setBreakpoint("/tmp/app.js", 20)

			const args = captured.at(-1)?.args as { breakpoints: Array<{ line: number }> }
			expect(args.breakpoints).toHaveLength(2)
			expect(args.breakpoints.map((b) => b.line)).toEqual([10, 20])
		})
	})

	describe("execution control", () => {
		it("continue registers a stop waiter before sending the request", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			await session.completeLaunch()
			client.threadId = 1

			queueResponse("continue", {})
			// Fire the stopped event AFTER the continue request is captured but
			// before we await the promise — proves the waiter was registered
			// synchronously (race-safe).
			const stopP = session.continue()
			await Promise.resolve() // let stepAndStop register the waiter
			client.emitEvent("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: false })
			const event = await stopP

			expect(event.reason).toBe("breakpoint")
			expect(captured.at(-1)?.command).toBe("continue")
		})

		it("stepIn sends stepIn and resolves with the stopped event", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			await session.completeLaunch()
			client.threadId = 1

			queueResponse("stepIn", {})
			const stopP = session.stepIn()
			await Promise.resolve() // let stepAndStop register the waiter
			client.emitEvent("stopped", { reason: "step", threadId: 1, allThreadsStopped: false })
			const event = await stopP
			expect(event.reason).toBe("step")
		})

		it("stepOver sends next (DAP's command for step-over)", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			await session.completeLaunch()
			client.threadId = 1

			queueResponse("next", {})
			const stopP = session.stepOver()
			await Promise.resolve() // let stepAndStop register the waiter
			client.emitEvent("stopped", { reason: "step", threadId: 1, allThreadsStopped: false })
			await stopP
			expect(captured.at(-1)?.command).toBe("next")
		})

		it("stepOut sends stepOut", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			await session.completeLaunch()
			client.threadId = 1

			queueResponse("stepOut", {})
			const stopP = session.stepOut()
			await Promise.resolve() // let stepAndStop register the waiter
			client.emitEvent("stopped", { reason: "step", threadId: 1, allThreadsStopped: false })
			await stopP
			expect(captured.at(-1)?.command).toBe("stepOut")
		})

		it("rejects when the debuggee terminates before reaching a stop", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			await session.completeLaunch() // consume the pending launch response
			client.threadId = 1

			queueResponse("continue", {})
			const stopP = session.continue()
			await Promise.resolve() // let stepAndStop register the waiter
			client.emitEvent("terminated", {})
			await expect(stopP).rejects.toThrow("terminated before reaching a stop")
		})
	})

	describe("inspection", () => {
		it("getStackFrame returns stack frames for the current thread", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			client.threadId = 1

			const frames: StackFrame[] = [{ id: 1, name: "main", line: 5, column: 1, source: { path: "/tmp/app.js" } }]
			queueResponse("stackTrace", { stackFrames: frames })
			const result = await session.getStackFrame()
			expect(result).toEqual(frames)
			expect((captured.at(-1)?.args as { threadId: number }).threadId).toBe(1)
		})

		it("ensureThreadId queries threads when no threadId is tracked", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			// No client.threadId set — should fall back to `threads` request
			queueResponse("threads", { threads: [{ id: 42, name: "main" }] })
			queueResponse("stackTrace", { stackFrames: [] })

			await session.getStackFrame()
			expect(client.threadId).toBe(42)
		})

		it("ensureThreadId throws when adapter reports no threads", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			// Queue enough empty `threads` responses for the retry loop (20 attempts)
			for (let i = 0; i < 20; i++) queueResponse("threads", { threads: [] })

			await expect(session.getStackFrame()).rejects.toThrow("no debuggee threads")
		})

		it("getScopes returns scopes for a frame", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			const scopes: Scope[] = [{ name: "Locals", variablesReference: 100, expensive: false }]
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			queueResponse("scopes", { scopes })
			const result = await session.getScopes(1)
			expect(result).toEqual(scopes)
		})

		it("getVariables returns variables for a reference", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			const vars: Variable[] = [{ name: "x", value: "42", type: "number", variablesReference: 0 }]
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			queueResponse("variables", { variables: vars })
			const result = await session.getVariables(100)
			expect(result).toEqual(vars)
		})

		it("evaluate returns the DapEvaluateResult", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			const evalResult: DapEvaluateResult = { result: "42", type: "number", variablesReference: 0 }
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			queueResponse("evaluate", evalResult)
			const result = await session.evaluate("x", 1)
			expect(result.result).toBe("42")
			expect(result.type).toBe("number")
		})

		it("evaluate throws when adapter returns no result string", async () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			queueResponse("evaluate", { variablesReference: 0 })
			await expect(session.evaluate("x", 1)).rejects.toThrow("no result")
		})
	})

	describe("terminate", () => {
		it("sends terminate request when supported, then kills proc", async () => {
			const client = createMockClient({ supportsTerminateRequest: true } as DapCapabilities)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			queueResponse("terminate", {})

			await session.terminate()
			expect(session.isTerminated).toBe(true)
			expect(captured.at(-1)?.command).toBe("terminate")
		})

		it("skips terminate request when unsupported and just kills proc", async () => {
			const client = createMockClient({ supportsTerminateRequest: false } as DapCapabilities)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })

			await session.terminate()
			expect(session.isTerminated).toBe(true)
			expect(captured.find((r) => r.command === "terminate")).toBeUndefined()
		})

		it("is idempotent — second call is a no-op", async () => {
			const client = createMockClient({ supportsTerminateRequest: true } as DapCapabilities)
			const session = makeSession(client)
			queueResponse("launch", {})
			await session.launch({ program: "/tmp/app.js", cwd: CWD })
			queueResponse("terminate", {})

			await session.terminate()
			const firstCaptured = captured.length
			await session.terminate()
			expect(captured.length).toBe(firstCaptured)
		})
	})

	describe("session registry", () => {
		it("createSession registers the session and getSession retrieves it", () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			expect(getSession(session.id)).toBe(session)
		})

		it("removeSession removes it from the registry", () => {
			const client = createMockClient(null)
			const session = makeSession(client)
			removeSession(session.id)
			expect(getSession(session.id)).toBeUndefined()
		})

		it("getActiveSessions returns all registered sessions", () => {
			const client1 = createMockClient(null)
			const client2 = createMockClient(null)
			const s1 = makeSession(client1)
			const s2 = makeSession(client2)
			expect(getActiveSessions()).toHaveLength(2)
			expect(
				getActiveSessions()
					.map((s) => s.id)
					.sort(),
			).toEqual([s1.id, s2.id].sort())
		})

		it("clearAllSessions empties the registry", () => {
			const client = createMockClient(null)
			makeSession(client)
			expect(getActiveSessions()).toHaveLength(1)
			clearAllSessions()
			expect(getActiveSessions()).toHaveLength(0)
		})
	})
})
