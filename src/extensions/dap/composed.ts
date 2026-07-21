// extensions/dap/composed.ts
//
// Layer 2 composed tools — the load-bearing value of the DAP extension.
// Each tool collapses a multi-step DAP dance (launch → breakpoint → continue →
// inspect → terminate) into a single call. Every tool:
//   - Accepts an optional sessionId (use existing session, don't terminate) or
//     creates its own (terminate on ALL paths: success, timeout, error).
//   - Enforces a wall-clock timeout (default 30s) via Promise.race.
//   - Terminates the created session in a `finally` block so cleanup runs even
//     on timeout/error.
//
// Tools:
//   - debugStateAt: set breakpoint, run to it, collect locals/backtrace/eval/output
//   - debugLastError: run until exception, collect throw-site state
//   - debugTraceCalls: run to completion, parse __KIMCHI_TRACE__ sentinels
//   - debugWatchChange: step through code, detect expression value changes

import type { DapSession } from "./session.js"
import type { DapEvaluateResult, StackFrame, StoppedEvent, Variable } from "./types.js"

// =============================================================================
// Constants
// =============================================================================

export const DEFAULT_COMPOSED_TIMEOUT_MS = 30_000
export const TRACE_SENTINEL = "__KIMCHI_TRACE__"
const MAX_OUTPUT_BYTES = 5_000
const MAX_TRACE_CALLS = 1000

// =============================================================================
// Types — deps (structurally compatible with DapToolDeps from tools.ts)
// =============================================================================

/** Dependencies injected into composed tools. Structurally compatible with
 *  DapToolDeps from tools.ts — the existing deps object can be passed directly. */
export interface ComposedDeps {
	cwd: string
	getSession: (id: string) => DapSession | undefined
	launchSession: (opts: { program: string; stopOnEntry?: boolean }) => Promise<DapSession>
}

// =============================================================================
// Result types
// =============================================================================

export interface EvaluatedExpression {
	expression: string
	result?: DapEvaluateResult
	error?: string
}

export interface DebugStateAtResult {
	hit: boolean
	locals: Variable[]
	backtrace: StackFrame[]
	evaluated: EvaluatedExpression[]
	stdout: string
	stderr: string
}

export interface DebugLastErrorResult {
	exception: { type: string; message: string }
	locals_at_throw: Variable[]
	backtrace: StackFrame[]
	stdout: string
	stderr: string
}

export interface TraceCall {
	fn?: string
	args?: unknown[]
	result?: unknown
	line?: number
	file?: string
	[key: string]: unknown
}

export interface DebugTraceCallsResult {
	calls: TraceCall[]
	truncated: boolean
}

export interface WatchChange {
	at: StackFrame | null
	old: string
	new: string
}

export interface DebugWatchChangeResult {
	changes: WatchChange[]
	method: "data-breakpoint" | "polling"
}

// =============================================================================
// Error class
// =============================================================================

export class ComposedTimeoutError extends Error {
	constructor(ms: number) {
		super(`DAP composed tool timed out after ${ms}ms`)
		this.name = "ComposedTimeoutError"
	}
}

// =============================================================================
// Shared helpers
// =============================================================================

/** Truncate output to MAX_OUTPUT_BYTES, keeping head + tail with a separator. */
function truncateOutput(text: string): string {
	if (text.length <= MAX_OUTPUT_BYTES) return text
	const half = Math.floor(MAX_OUTPUT_BYTES / 2)
	const head = text.slice(0, half)
	const tail = text.slice(-half)
	const omitted = text.length - MAX_OUTPUT_BYTES
	return `${head}\n\n... [truncated ${omitted} bytes] ...\n\n${tail}`
}

/** Collect stdout/stderr from DapOutputLine array. Categories "stdout" and
 *  "console" map to stdout; "stderr" maps to stderr. */
function collectOutput(lines: ReadonlyArray<{ category: string; text: string }>): {
	stdout: string
	stderr: string
} {
	let stdout = ""
	let stderr = ""
	for (const line of lines) {
		if (line.category === "stderr") {
			stderr += `${line.text}\n`
		} else if (line.category === "stdout" || line.category === "console") {
			stdout += `${line.text}\n`
		}
	}
	return { stdout: truncateOutput(stdout), stderr: truncateOutput(stderr) }
}

/** Collect all local variables from all non-empty scopes of the top frame
 *  (or a specific frame if provided). */
async function collectLocals(session: DapSession, frameId?: number): Promise<Variable[]> {
	const frames = await session.getStackFrame()
	const fid = frameId ?? frames[0]?.id
	if (fid === undefined) return []
	const scopes = await session.getScopes(fid)
	const variables: Variable[] = []
	for (const scope of scopes) {
		if (scope.variablesReference === 0) continue
		const vars = await session.getVariables(scope.variablesReference)
		for (const v of vars) {
			variables.push(v)
			// Expand one level of nested variables so the agent can see struct
			// fields without debug_eval (which fails on unexported fields in Go).
			if (v.variablesReference > 0) {
				const children = await session.getVariables(v.variablesReference)
				for (const child of children) {
					variables.push({
						...child,
						name: `${v.name}.${child.name}`,
					})
				}
			}
		}
	}
	return variables
}

/** Resolve a session: use an existing one by id (don't terminate), or create
 *  a new one from the program path (terminate on all paths). */
async function resolveSession(
	deps: ComposedDeps,
	sessionId: string | undefined,
	program: string,
): Promise<{ session: DapSession; shouldTerminate: boolean }> {
	if (sessionId) {
		const session = deps.getSession(sessionId)
		if (!session) throw new Error(`No DAP session found for sessionId: ${sessionId}`)
		return { session, shouldTerminate: false }
	}
	// Launch with stopOnEntry so breakpoints can be set BEFORE the debuggee
	// runs — otherwise adapters like dlv dap start the program immediately on
	// configurationDone and it may exit before the breakpoint is registered.
	const session = await deps.launchSession({ program, stopOnEntry: true })
	return { session, shouldTerminate: true }
}

/** Race work against a wall-clock timeout. On ANY path (success, timeout,
 *  error), run cleanup (e.g. terminate the created session). Cleanup errors
 *  are swallowed so they don't mask the original error. */
async function withTimeoutAndCleanup<T>(
	timeoutMs: number,
	work: () => Promise<T>,
	cleanup: () => Promise<void>,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeoutP = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ComposedTimeoutError(timeoutMs)), timeoutMs)
	})
	try {
		return await Promise.race([work(), timeoutP])
	} finally {
		if (timer) clearTimeout(timer)
		await cleanup().catch(() => {})
	}
}

/** Returns true if the error indicates the debuggee terminated (expected when
 *  running to completion). */
function isTerminatedError(err: unknown): boolean {
	return err instanceof Error && err.message.includes("terminated")
}

/** Evaluate an expression and return its string representation. */
async function evaluateString(session: DapSession, expression: string): Promise<string> {
	const result = await session.evaluate(expression)
	return result.result
}

/** Parse trace sentinels from output lines. */
function parseTraceCalls(lines: ReadonlyArray<{ category: string; text: string }>): {
	calls: TraceCall[]
	truncated: boolean
} {
	const calls: TraceCall[] = []
	for (const line of lines) {
		const idx = line.text.indexOf(TRACE_SENTINEL)
		if (idx === -1) continue
		const jsonPart = line.text.slice(idx + TRACE_SENTINEL.length)
		try {
			const parsed = JSON.parse(jsonPart) as TraceCall
			calls.push(parsed)
		} catch {
			// Malformed JSON after sentinel — skip this line
		}
	}
	let truncated = false
	if (calls.length > MAX_TRACE_CALLS) {
		truncated = true
		calls.length = MAX_TRACE_CALLS
	}
	return { calls, truncated }
}

// =============================================================================
// Tool 1: debug_state_at
// =============================================================================

export interface DebugStateAtOptions {
	file: string
	line: number
	sessionId?: string
	evaluated?: string[]
	timeoutMs?: number
}

/** Set a breakpoint at file:line, continue to it, and collect the full state
 *  at that point: locals, backtrace, evaluated expressions, and captured
 *  stdout/stderr. Returns {hit: false, ...} if the program runs to completion
 *  without hitting the breakpoint. */
export async function debugStateAt(deps: ComposedDeps, opts: DebugStateAtOptions): Promise<DebugStateAtResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMPOSED_TIMEOUT_MS
	const { session, shouldTerminate } = await resolveSession(deps, opts.sessionId, opts.file)

	return withTimeoutAndCleanup(
		timeoutMs,
		async () => {
			await session.setBreakpoint(opts.file, opts.line)
			await session.completeLaunch()
			let stop: StoppedEvent
			try {
				stop = await session.continue()
			} catch (err) {
				if (isTerminatedError(err)) {
					const { stdout, stderr } = collectOutput(session.outputLines)
					return { hit: false, locals: [], backtrace: [], evaluated: [], stdout, stderr }
				}
				throw err
			}
			const hit =
				stop.reason === "breakpoint" ||
				stop.reason === "function breakpoint" ||
				stop.reason === "instruction breakpoint"
			const locals = await collectLocals(session)
			const backtrace = await session.getStackFrame()
			const evaluated: EvaluatedExpression[] = []
			for (const expr of opts.evaluated ?? []) {
				try {
					const result = await session.evaluate(expr)
					evaluated.push({ expression: expr, result })
				} catch (e) {
					evaluated.push({
						expression: expr,
						error: e instanceof Error ? e.message : String(e),
					})
				}
			}
			const { stdout, stderr } = collectOutput(session.outputLines)
			return { hit, locals, backtrace, evaluated, stdout, stderr }
		},
		async () => {
			if (shouldTerminate) await session.terminate()
		},
	)
}

// =============================================================================
// Tool 2: debug_last_error
// =============================================================================

export interface DebugLastErrorOptions {
	program: string
	sessionId?: string
	timeoutMs?: number
}

/** Launch the program and continue until an exception is hit or the program
 *  terminates. Returns the exception type/message, locals at the throw site,
 *  and backtrace. Returns null if the program completes without throwing. */
export async function debugLastError(
	deps: ComposedDeps,
	opts: DebugLastErrorOptions,
): Promise<DebugLastErrorResult | null> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMPOSED_TIMEOUT_MS
	const { session, shouldTerminate } = await resolveSession(deps, opts.sessionId, opts.program)

	return withTimeoutAndCleanup(
		timeoutMs,
		async () => {
			await session.completeLaunch()
			// Loop: continue until we hit an exception or the program terminates.
			// Most DAP adapters stop on uncaught exceptions by default.
			while (true) {
				let stop: StoppedEvent
				try {
					stop = await session.continue()
				} catch (err) {
					if (isTerminatedError(err)) {
						// Program ran to completion without an exception
						return null
					}
					throw err
				}
				if (stop.reason === "exception") {
					const exception = {
						type: stop.text ?? "exception",
						message: stop.description ?? stop.text ?? "unknown exception",
					}
					const locals = await collectLocals(session)
					const backtrace = await session.getStackFrame()
					const { stdout, stderr } = collectOutput(session.outputLines)
					return { exception, locals_at_throw: locals, backtrace, stdout, stderr }
				}
				// Stopped for another reason (breakpoint, step, entry) — continue
			}
		},
		async () => {
			if (shouldTerminate) await session.terminate()
		},
	)
}

// =============================================================================
// Tool 3: debug_trace_calls
// =============================================================================

export interface DebugTraceCallsOptions {
	program: string
	sessionId?: string
	timeoutMs?: number
}

/** Launch the program and run it to completion. Parse all output lines
 *  containing the __KIMCHI_TRACE__ sentinel, extracting structured call
 *  records (fn, args, result) from the JSON payload that follows the sentinel.
 *  Returns {calls, truncated} where truncated is true if >1000 calls were
 *  captured. */
export async function debugTraceCalls(
	deps: ComposedDeps,
	opts: DebugTraceCallsOptions,
): Promise<DebugTraceCallsResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMPOSED_TIMEOUT_MS
	const { session, shouldTerminate } = await resolveSession(deps, opts.sessionId, opts.program)

	return withTimeoutAndCleanup(
		timeoutMs,
		async () => {
			await session.completeLaunch()
			// Run the program to completion — continue rejects on terminated.
			try {
				await session.continue()
			} catch (err) {
				if (!isTerminatedError(err)) throw err
			}
			return parseTraceCalls(session.outputLines)
		},
		async () => {
			if (shouldTerminate) await session.terminate()
		},
	)
}

// =============================================================================
// Tool 4: debug_watch_change
// =============================================================================

export interface DebugWatchChangeOptions {
	program: string
	file: string
	line: number
	expression: string
	sessionId?: string
	timeoutMs?: number
}

/** Watch an expression for value changes. Sets a breakpoint at file:line,
 *  runs to it, then steps through the code evaluating the expression at each
 *  stop. Records each change with the stack frame where it occurred.
 *
 *  For v1, always uses expression polling (works with all adapters). The
 *  data-breakpoint capability is detected and reported in the result, but the
 *  data-breakpoint code path requires DapSession methods (dataBreakpointInfo,
 *  setDataBreakpoints) that are not yet implemented — polling is the robust
 *  universal fallback. */
export async function debugWatchChange(
	deps: ComposedDeps,
	opts: DebugWatchChangeOptions,
): Promise<DebugWatchChangeResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMPOSED_TIMEOUT_MS
	const { session, shouldTerminate } = await resolveSession(deps, opts.sessionId, opts.program)
	const supportsDataBp = session.capabilities?.supportsDataBreakpoints === true
	// v1: always use polling. The capability is detected for future use but
	// the data-breakpoint code path is not yet implemented.
	void supportsDataBp

	return withTimeoutAndCleanup(
		timeoutMs,
		async () => {
			// Set breakpoint and run to it
			await session.setBreakpoint(opts.file, opts.line)
			await session.completeLaunch()
			await session.continue()

			// Get initial value
			let oldValue = await evaluateString(session, opts.expression)
			const changes: WatchChange[] = []

			// Step through the program, watching for value changes
			while (true) {
				try {
					await session.stepOver()
				} catch (err) {
					if (isTerminatedError(err)) break
					throw err
				}
				let newValue: string
				try {
					newValue = await evaluateString(session, opts.expression)
				} catch {
					// Expression may not be in scope at this step — skip
					continue
				}
				if (newValue !== oldValue) {
					const frames = await session.getStackFrame()
					changes.push({
						at: frames[0] ?? null,
						old: oldValue,
						new: newValue,
					})
					oldValue = newValue
				}
			}
			return {
				changes,
				// v1 always polls; data-breakpoint code path is a v2 enhancement
				// (requires DapSession.dataBreakpointInfo + setDataBreakpoints).
				method: "polling" as const,
			}
		},
		async () => {
			if (shouldTerminate) await session.terminate()
		},
	)
}
