// extensions/dap/composed.test.ts
//
// Verifies the Layer 2 composed tools' orchestration logic: each tool's
// multi-step DAP dance (breakpoint → continue → inspect → terminate),
// timeout enforcement (tight timeout against a hanging program), stdout/stderr
// capture with 5KB head+tail truncation, session cleanup on ALL paths
// (success, timeout, error), and debug_watch_change's polling fallback.
//
// Uses a stub DapSession (vi.fn methods + mutable outputLines/capabilities
// fields) so assertions are on the orchestration, not the DAP wire protocol.
// No subprocesses are spawned.

import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ComposedDeps } from "./composed.js"
import {
	ComposedTimeoutError,
	DEFAULT_COMPOSED_TIMEOUT_MS,
	debugLastError,
	debugStateAt,
	debugTraceCalls,
	debugWatchChange,
	TRACE_SENTINEL,
} from "./composed.js"
import type { DapSession } from "./session.js"
import type {
	Breakpoint,
	DapAdapterConfig,
	DapCapabilities,
	DapEvaluateResult,
	DapOutputLine,
	Scope,
	StackFrame,
	StoppedEvent,
	Variable,
} from "./types.js"

// =============================================================================
// Stub DapSession — vi.fn methods + mutable outputLines/capabilities
// =============================================================================

interface StubSession extends DapSession {
	id: string
	adapter: DapAdapterConfig
	cwd: string
	setBreakpoint: ReturnType<typeof vi.fn>
	continue: ReturnType<typeof vi.fn>
	stepOver: ReturnType<typeof vi.fn>
	getStackFrame: ReturnType<typeof vi.fn>
	getScopes: ReturnType<typeof vi.fn>
	getVariables: ReturnType<typeof vi.fn>
	evaluate: ReturnType<typeof vi.fn>
	terminate: ReturnType<typeof vi.fn>
	launch: ReturnType<typeof vi.fn>
	completeLaunch: ReturnType<typeof vi.fn>
	isLaunched: boolean
	isTerminated: boolean
	threadId: number | null
	// Mutable backing fields for the getters on DapSession
	outputLines: DapOutputLine[]
	capabilities: DapCapabilities | null
}

const ADAPTER: DapAdapterConfig = {
	name: "js-debug",
	command: "js-debug-adapter",
	args: [],
	languages: ["typescript"],
	extensions: [".ts"],
	launchType: "node",
}

function createStubSession(id = "sess-aaa-bbb-ccc"): StubSession {
	return {
		id,
		adapter: ADAPTER,
		cwd: "/tmp",
		setBreakpoint: vi.fn().mockResolvedValue({ verified: true, line: 10 } as Breakpoint),
		continue: vi.fn().mockResolvedValue({ reason: "breakpoint", threadId: 1 } as StoppedEvent),
		stepOver: vi.fn().mockResolvedValue({ reason: "step", threadId: 1 } as StoppedEvent),
		getStackFrame: vi.fn().mockResolvedValue([{ id: 1, name: "main", line: 10, column: 1 }] as StackFrame[]),
		getScopes: vi.fn().mockResolvedValue([{ name: "Locals", variablesReference: 100, expensive: false }] as Scope[]),
		getVariables: vi
			.fn()
			.mockResolvedValue([{ name: "x", value: "42", type: "number", variablesReference: 0 }] as Variable[]),
		evaluate: vi.fn().mockResolvedValue({ result: "42", variablesReference: 0 } as DapEvaluateResult),
		terminate: vi.fn().mockResolvedValue(undefined),
		launch: vi.fn().mockResolvedValue(undefined),
		completeLaunch: vi.fn().mockResolvedValue(undefined),
		isLaunched: true,
		isTerminated: false,
		threadId: 1,
		outputLines: [],
		capabilities: null,
	} as unknown as StubSession
}

// =============================================================================
// Deps factory — getSession + launchSession wired to stubs
// =============================================================================

function createDeps(stub?: StubSession): { deps: ComposedDeps; sessions: Map<string, StubSession> } {
	const sessions = new Map<string, StubSession>()
	if (stub) sessions.set(stub.id, stub)
	const deps: ComposedDeps = {
		cwd: "/tmp",
		getSession: (id: string) => sessions.get(id),
		launchSession: async (opts: { program: string }) => {
			const s = createStubSession("launched-ddd-eee-fff")
			sessions.set(s.id, s)
			await s.launch(opts)
			return s
		},
	}
	return { deps, sessions }
}

// =============================================================================
// Helpers
// =============================================================================

/** Build a StoppedEvent with the given reason. */
function stop(reason: StoppedEvent["reason"], desc?: string): StoppedEvent {
	return { reason, threadId: 1, description: desc } as StoppedEvent
}

/** Build a StackFrame with source. */
function frame(id: number, name: string, file: string, line: number): StackFrame {
	return { id, name, line, column: 1, source: { path: file } }
}

// =============================================================================
// Tests
// =============================================================================

describe("composed tools — constants", () => {
	it("exports DEFAULT_COMPOSED_TIMEOUT_MS = 30000", () => {
		expect(DEFAULT_COMPOSED_TIMEOUT_MS).toBe(30_000)
	})

	it("exports TRACE_SENTINEL = __KIMCHI_TRACE__", () => {
		expect(TRACE_SENTINEL).toBe("__KIMCHI_TRACE__")
	})

	it("ComposedTimeoutError carries the timeout ms in its message", () => {
		const err = new ComposedTimeoutError(123)
		expect(err).toBeInstanceOf(Error)
		expect(err.name).toBe("ComposedTimeoutError")
		expect(err.message).toContain("123ms")
	})
})

// ── debug_state_at ──────────────────────────────────────────────────────────

describe("debug_state_at", () => {
	beforeEach(() => vi.useRealTimers())

	it("sets breakpoint, continues, and returns hit + locals + backtrace + evaluated + stdout + stderr", async () => {
		const stub = createStubSession()
		stub.continue.mockResolvedValue(stop("breakpoint"))
		stub.getStackFrame.mockResolvedValue([frame(1, "main", "app.ts", 10), frame(2, "helper", "util.ts", 20)])
		stub.getVariables.mockResolvedValue([{ name: "x", value: "42", type: "number", variablesReference: 0 }])
		stub.outputLines = [
			{ category: "stdout", text: "hello" },
			{ category: "stderr", text: "warn" },
		]
		const { deps } = createDeps(stub)

		const result = await debugStateAt(deps, {
			sessionId: stub.id,
			file: "app.ts",
			line: 10,
			evaluated: ["x + 1"],
		})

		expect(result.hit).toBe(true)
		expect(stub.setBreakpoint).toHaveBeenCalledWith("app.ts", 10)
		expect(stub.continue).toHaveBeenCalledTimes(1)
		expect(result.locals).toHaveLength(1)
		expect(result.locals[0].name).toBe("x")
		expect(result.locals[0].value).toBe("42")
		expect(result.backtrace).toHaveLength(2)
		expect(result.backtrace[0].name).toBe("main")
		expect(result.evaluated).toHaveLength(1)
		expect(result.evaluated[0].expression).toBe("x + 1")
		expect(result.evaluated[0].result?.result).toBe("42")
		expect(result.stdout).toContain("hello")
		expect(result.stderr).toContain("warn")
		// Existing session (sessionId provided) must NOT be terminated
		expect(stub.terminate).not.toHaveBeenCalled()
	})

	it("returns hit:false when the program terminates before hitting the breakpoint", async () => {
		const stub = createStubSession()
		stub.continue.mockRejectedValue(new Error("Debuggee terminated before reaching a stop"))
		stub.outputLines = [{ category: "stdout", text: "ran to completion" }]
		const { deps } = createDeps(stub)

		const result = await debugStateAt(deps, { sessionId: stub.id, file: "app.ts", line: 10 })

		expect(result.hit).toBe(false)
		expect(result.locals).toEqual([])
		expect(result.backtrace).toEqual([])
		expect(result.stdout).toContain("ran to completion")
	})

	it("creates and terminates a new session when no sessionId is provided", async () => {
		const stub = createStubSession()
		stub.continue.mockResolvedValue(stop("breakpoint"))
		stub.getVariables.mockResolvedValue([])
		const { deps } = createDeps()

		// Override launchSession to return our controllable stub
		let launched: StubSession | undefined
		deps.launchSession = async () => {
			launched = stub
			return stub as unknown as DapSession
		}

		await debugStateAt(deps, { file: "app.ts", line: 10 })

		if (!launched) throw new Error("launchSession was not called")
		expect(launched.setBreakpoint).toHaveBeenCalledWith("app.ts", 10)
		expect(launched.terminate).toHaveBeenCalledTimes(1)
	})

	it("captures per-expression errors without aborting the whole capture", async () => {
		const stub = createStubSession()
		stub.continue.mockResolvedValue(stop("breakpoint"))
		stub.evaluate
			.mockResolvedValueOnce({ result: "42", variablesReference: 0 })
			.mockRejectedValueOnce(new Error("expression not in scope"))
		const { deps } = createDeps(stub)

		const result = await debugStateAt(deps, {
			sessionId: stub.id,
			file: "app.ts",
			line: 10,
			evaluated: ["good", "bad"],
		})

		expect(result.evaluated).toHaveLength(2)
		expect(result.evaluated[0].result?.result).toBe("42")
		expect(result.evaluated[1].error).toBe("expression not in scope")
		expect(result.evaluated[1].result).toBeUndefined()
	})

	it("terminates the created session on timeout (tight timeout against a hanging continue)", async () => {
		const stub = createStubSession()
		// continue never resolves → simulates a hanging program
		stub.continue.mockReturnValue(new Promise(() => {}))
		const { deps } = createDeps()
		deps.launchSession = async () => stub as unknown as DapSession

		await expect(debugStateAt(deps, { file: "app.ts", line: 10, timeoutMs: 50 })).rejects.toThrow(ComposedTimeoutError)

		// Session must be terminated even though the work timed out
		expect(stub.terminate).toHaveBeenCalledTimes(1)
	})

	it("propagates errors from setBreakpoint and still terminates the created session", async () => {
		const stub = createStubSession()
		stub.setBreakpoint.mockRejectedValue(new Error("DAP setBreakpoints failed"))
		const { deps } = createDeps()
		deps.launchSession = async () => stub as unknown as DapSession

		await expect(debugStateAt(deps, { file: "app.ts", line: 10 })).rejects.toThrow("DAP setBreakpoints failed")

		expect(stub.terminate).toHaveBeenCalledTimes(1)
	})
})

// ── debug_last_error ─────────────────────────────────────────────────────────

describe("debug_last_error", () => {
	it("loops continue until an exception stop and returns exception + locals + backtrace", async () => {
		const stub = createStubSession()
		// First stop is a breakpoint (non-exception), second is the exception
		stub.continue.mockResolvedValueOnce(stop("breakpoint")).mockResolvedValueOnce({
			reason: "exception",
			text: "TypeError",
			description: "cannot read 'x' of undefined",
			threadId: 1,
		} as StoppedEvent)
		stub.getVariables.mockResolvedValue([{ name: "obj", value: "undefined", variablesReference: 0 }])
		stub.getStackFrame.mockResolvedValue([frame(1, "throwFn", "app.ts", 42)])
		const { deps } = createDeps(stub)

		const result = await debugLastError(deps, { sessionId: stub.id, program: "app.ts" })

		if (!result) throw new Error("expected a non-null result")
		expect(stub.continue).toHaveBeenCalledTimes(2)
		expect(result.exception.type).toBe("TypeError")
		expect(result.exception.message).toBe("cannot read 'x' of undefined")
		expect(result.locals_at_throw[0].name).toBe("obj")
		expect(result.backtrace[0].name).toBe("throwFn")
		// Existing session — no terminate
		expect(stub.terminate).not.toHaveBeenCalled()
	})

	it("returns null when the program completes without throwing", async () => {
		const stub = createStubSession()
		stub.continue.mockRejectedValue(new Error("Debuggee terminated before reaching a stop"))
		const { deps } = createDeps(stub)

		const result = await debugLastError(deps, { sessionId: stub.id, program: "app.ts" })

		expect(result).toBeNull()
	})

	it("terminates the created session on timeout", async () => {
		const stub = createStubSession()
		stub.continue.mockReturnValue(new Promise(() => {}))
		const { deps } = createDeps()
		deps.launchSession = async () => stub as unknown as DapSession

		await expect(debugLastError(deps, { program: "app.ts", timeoutMs: 50 })).rejects.toThrow(ComposedTimeoutError)

		expect(stub.terminate).toHaveBeenCalledTimes(1)
	})
})

// ── debug_trace_calls ────────────────────────────────────────────────────────

describe("debug_trace_calls", () => {
	it("runs to completion and parses __KIMCHI_TRACE__ sentinels into structured calls", async () => {
		const stub = createStubSession()
		// continue rejects with "terminated" — expected for run-to-completion
		stub.continue.mockRejectedValue(new Error("Debuggee terminated before reaching a stop"))
		stub.outputLines = [
			{ category: "stdout", text: `${TRACE_SENTINEL}{"fn":"add","args":[1,2],"result":3}` },
			{ category: "stdout", text: "some regular output" },
			{ category: "stdout", text: `${TRACE_SENTINEL}{"fn":"mul","args":[3,4],"result":12}` },
		]
		const { deps } = createDeps(stub)

		const result = await debugTraceCalls(deps, { sessionId: stub.id, program: "app.ts" })

		expect(result.calls).toHaveLength(2)
		expect(result.calls[0].fn).toBe("add")
		expect(result.calls[0].args).toEqual([1, 2])
		expect(result.calls[0].result).toBe(3)
		expect(result.calls[1].fn).toBe("mul")
		expect(result.truncated).toBe(false)
	})

	it("skips malformed JSON after the sentinel", async () => {
		const stub = createStubSession()
		stub.continue.mockRejectedValue(new Error("terminated"))
		stub.outputLines = [
			{ category: "stdout", text: `${TRACE_SENTINEL}{"fn":"good"}` },
			{ category: "stdout", text: `${TRACE_SENTINEL}{not valid json}` },
			{ category: "stdout", text: `${TRACE_SENTINEL}{"fn":"alsoGood"}` },
		]
		const { deps } = createDeps(stub)

		const result = await debugTraceCalls(deps, { sessionId: stub.id, program: "app.ts" })

		expect(result.calls).toHaveLength(2)
		expect(result.calls[0].fn).toBe("good")
		expect(result.calls[1].fn).toBe("alsoGood")
	})

	it("truncates at 1000 calls and sets truncated:true", async () => {
		const stub = createStubSession()
		stub.continue.mockRejectedValue(new Error("terminated"))
		const lines: DapOutputLine[] = []
		for (let i = 0; i < 1200; i++) {
			lines.push({ category: "stdout", text: `${TRACE_SENTINEL}{"fn":"fn${i}"}` })
		}
		stub.outputLines = lines
		const { deps } = createDeps(stub)

		const result = await debugTraceCalls(deps, { sessionId: stub.id, program: "app.ts" })

		expect(result.calls).toHaveLength(1000)
		expect(result.truncated).toBe(true)
	})

	it("returns empty calls when no sentinels are present", async () => {
		const stub = createStubSession()
		stub.continue.mockRejectedValue(new Error("terminated"))
		stub.outputLines = [{ category: "stdout", text: "no trace here" }]
		const { deps } = createDeps(stub)

		const result = await debugTraceCalls(deps, { sessionId: stub.id, program: "app.ts" })

		expect(result.calls).toEqual([])
		expect(result.truncated).toBe(false)
	})

	it("terminates the created session on timeout (hanging continue)", async () => {
		const stub = createStubSession()
		stub.continue.mockReturnValue(new Promise(() => {}))
		const { deps } = createDeps()
		deps.launchSession = async () => stub as unknown as DapSession

		await expect(debugTraceCalls(deps, { program: "app.ts", timeoutMs: 50 })).rejects.toThrow(ComposedTimeoutError)

		expect(stub.terminate).toHaveBeenCalledTimes(1)
	})
})

// ── debug_watch_change ───────────────────────────────────────────────────────

describe("debug_watch_change", () => {
	it("steps through the program and records each value change with the frame location", async () => {
		const stub = createStubSession()
		// Breakpoint hit, then step → value changes, then step → value changes, then terminate
		stub.continue.mockResolvedValue(stop("breakpoint"))
		stub.stepOver
			.mockResolvedValueOnce(stop("step"))
			.mockResolvedValueOnce(stop("step"))
			.mockRejectedValueOnce(new Error("terminated"))
		// x starts at 1, becomes 2, becomes 3
		stub.evaluate
			.mockResolvedValueOnce({ result: "1", variablesReference: 0 })
			.mockResolvedValueOnce({ result: "2", variablesReference: 0 })
			.mockResolvedValueOnce({ result: "3", variablesReference: 0 })
		stub.getStackFrame.mockResolvedValue([frame(1, "main", "app.ts", 5)])
		const { deps } = createDeps(stub)

		const result = await debugWatchChange(deps, {
			sessionId: stub.id,
			program: "app.ts",
			file: "app.ts",
			line: 5,
			expression: "x",
		})

		expect(result.changes).toHaveLength(2)
		expect(result.changes[0].old).toBe("1")
		expect(result.changes[0].new).toBe("2")
		expect(result.changes[1].old).toBe("2")
		expect(result.changes[1].new).toBe("3")
		expect(result.changes[0].at?.source?.path).toBe("app.ts")
		expect(result.method).toBe("polling")
	})

	it("returns method:polling even when supportsDataBreakpoints capability is true", async () => {
		const stub = createStubSession()
		stub.capabilities = { supportsDataBreakpoints: true } as DapCapabilities
		stub.continue.mockResolvedValue(stop("breakpoint"))
		stub.stepOver.mockRejectedValueOnce(new Error("terminated"))
		stub.evaluate.mockResolvedValueOnce({ result: "1", variablesReference: 0 })
		const { deps } = createDeps(stub)

		const result = await debugWatchChange(deps, {
			sessionId: stub.id,
			program: "app.ts",
			file: "app.ts",
			line: 5,
			expression: "x",
		})

		// v1 always polls; data-breakpoint code path is a v2 enhancement
		expect(result.method).toBe("polling")
		expect(stub.capabilities?.supportsDataBreakpoints).toBe(true)
	})

	it("skips steps where the expression goes out of scope (evaluate throws)", async () => {
		const stub = createStubSession()
		stub.continue.mockResolvedValue(stop("breakpoint"))
		// Step 1: evaluate throws (out of scope), step 2: value changes, step 3: terminate
		stub.stepOver
			.mockResolvedValueOnce(stop("step"))
			.mockResolvedValueOnce(stop("step"))
			.mockRejectedValueOnce(new Error("terminated"))
		// Initial evaluate succeeds (x=1), then step 1's evaluate throws
		// (out of scope — skipped), step 2's evaluate returns a changed value,
		// step 3 terminates.
		stub.evaluate
			.mockResolvedValueOnce({ result: "1", variablesReference: 0 })
			.mockRejectedValueOnce(new Error("not in scope"))
			.mockResolvedValueOnce({ result: "2", variablesReference: 0 })
		stub.getStackFrame.mockResolvedValue([frame(1, "main", "app.ts", 5)])
		const { deps } = createDeps(stub)

		const result = await debugWatchChange(deps, {
			sessionId: stub.id,
			program: "app.ts",
			file: "app.ts",
			line: 5,
			expression: "x",
		})

		// Step 1's evaluate threw (out of scope) → skipped. Step 2 returned "2"
		// → one change recorded (old "1" → new "2").
		expect(result.changes).toHaveLength(1)
		expect(result.changes[0].old).toBe("1")
		expect(result.changes[0].new).toBe("2")
	})

	it("handles program terminating during the stepping loop (breaks cleanly)", async () => {
		const stub = createStubSession()
		stub.continue.mockResolvedValue(stop("breakpoint"))
		stub.stepOver.mockResolvedValueOnce(stop("step")).mockRejectedValueOnce(new Error("terminated"))
		stub.evaluate
			.mockResolvedValueOnce({ result: "1", variablesReference: 0 })
			.mockResolvedValueOnce({ result: "1", variablesReference: 0 })
		stub.getStackFrame.mockResolvedValue([frame(1, "main", "app.ts", 5)])
		const { deps } = createDeps(stub)

		const result = await debugWatchChange(deps, {
			sessionId: stub.id,
			program: "app.ts",
			file: "app.ts",
			line: 5,
			expression: "x",
		})

		// No changes (value stayed "1"), loop broke on terminated
		expect(result.changes).toHaveLength(0)
		expect(result.method).toBe("polling")
	})

	it("terminates the created session on timeout (hanging stepOver)", async () => {
		const stub = createStubSession()
		stub.continue.mockResolvedValue(stop("breakpoint"))
		stub.evaluate.mockResolvedValueOnce({ result: "1", variablesReference: 0 })
		stub.stepOver.mockReturnValue(new Promise(() => {}))
		const { deps } = createDeps()
		deps.launchSession = async () => stub as unknown as DapSession

		await expect(
			debugWatchChange(deps, {
				program: "app.ts",
				file: "app.ts",
				line: 5,
				expression: "x",
				timeoutMs: 50,
			}),
		).rejects.toThrow(ComposedTimeoutError)

		expect(stub.terminate).toHaveBeenCalledTimes(1)
	})
})

// ── stdout/stderr capture + truncation ───────────────────────────────────────

describe("output capture + truncation", () => {
	it("maps stdout and console categories to stdout, stderr to stderr", async () => {
		const stub = createStubSession()
		stub.continue.mockResolvedValue(stop("breakpoint"))
		stub.getVariables.mockResolvedValue([])
		stub.outputLines = [
			{ category: "stdout", text: "out1" },
			{ category: "console", text: "console1" },
			{ category: "stderr", text: "err1" },
		]
		const { deps } = createDeps(stub)

		const result = await debugStateAt(deps, { sessionId: stub.id, file: "app.ts", line: 10 })

		expect(result.stdout).toContain("out1")
		expect(result.stdout).toContain("console1")
		expect(result.stderr).toContain("err1")
		expect(result.stderr).not.toContain("out1")
		expect(result.stdout).not.toContain("err1")
	})

	it("truncates output >5KB with head + tail and a truncated-bytes marker", async () => {
		const stub = createStubSession()
		stub.continue.mockResolvedValue(stop("breakpoint"))
		stub.getVariables.mockResolvedValue([])
		const big = "x".repeat(6000)
		stub.outputLines = [{ category: "stdout", text: big }]
		const { deps } = createDeps(stub)

		const result = await debugStateAt(deps, { sessionId: stub.id, file: "app.ts", line: 10 })

		// Head + tail each ~2500 chars, plus the truncation marker
		expect(result.stdout.length).toBeLessThan(6000)
		expect(result.stdout).toContain("[truncated")
		expect(result.stdout).toContain("bytes]")
		// Head and tail are both present
		expect(result.stdout.startsWith("x")).toBe(true)
		expect(result.stdout.endsWith("x\n")).toBe(true)
	})

	it("does not truncate output <=5KB", async () => {
		const stub = createStubSession()
		stub.continue.mockResolvedValue(stop("breakpoint"))
		stub.getVariables.mockResolvedValue([])
		const small = "y".repeat(4000)
		stub.outputLines = [{ category: "stdout", text: small }]
		const { deps } = createDeps(stub)

		const result = await debugStateAt(deps, { sessionId: stub.id, file: "app.ts", line: 10 })

		expect(result.stdout).not.toContain("[truncated")
		expect(result.stdout).toContain(small)
	})
})
