// extensions/dap/session.ts
//
// DapSession — a thin, typed wrapper over the DapClient (client.ts) that adds
// per-session debug state (breakpoints, threadId, current frame) and the
// primitive debug operations Layer 2 composed tools build on. Mirrors the
// layering of lsp/client.ts (wire transport) ← lsp session logic ← tools.
//
// Key design decisions:
// - One DapSession per `debug_launch` call (registered in a module-level Map
//   keyed by sessionId). The underlying DapClient is keyed by (adapter,cwd) in
//   client.ts; DapSession adds launch-time state on top.
// - `continue()` / `stepIn/Over/Out()` register a `stopped` waiter BEFORE
//   sending the request, then await it. This is race-safe: the waiter is pushed
//   synchronously before the first `await` (sendRequest), so the reader loop
//   can't process the stopped event before the waiter exists.
// - `terminate()` is best-effort: sends `terminate` if supported (short
//   timeout), then SIGKILLs the proc unconditionally. Matches the shutdownAll
//   philosophy that DAP has no safe clean-shutdown handshake under forced kill.
//   The client.ts `exited` handler cleans the client map when the proc dies.

import { randomUUID } from "node:crypto"
import { sendRequest } from "./client.js"
import type {
	Breakpoint,
	DapAdapterConfig,
	DapCapabilities,
	DapClient,
	DapEvaluateResult,
	DapOutputLine,
	DapStoppedWaiter,
	DapTerminatedWaiter,
	Scope,
	StackFrame,
	StoppedEvent,
	Thread,
	Variable,
} from "./types.js"

// =============================================================================
// Session-local option types
// =============================================================================

export interface DapSessionLaunchOptions {
	/** Absolute path to the program to debug (compiled binary, .js entry, .go file, etc.). */
	program: string
	/** Working directory for the debuggee. */
	cwd: string
	/** Arguments passed to the debuggee (not the adapter). */
	args?: string[]
	/** If true, the debuggee stops on entry and waits for a continue/step. */
	stopOnEntry?: boolean
	/** Extra environment variables for the debuggee. */
	env?: Record<string, string>
}

export interface DapSessionOptions {
	adapter: DapAdapterConfig
	cwd: string
	/** A connected DapClient (from getOrCreateClient) — the wire transport. */
	client: DapClient
	/** Per-request timeout (default 30s, matches client.ts DEFAULT_TIMEOUT_MS). */
	timeoutMs?: number
}

// =============================================================================
// DapSession
// =============================================================================

export class DapSession {
	readonly id: string
	readonly adapter: DapAdapterConfig
	readonly cwd: string
	private readonly client: DapClient
	private readonly timeoutMs: number
	private launched = false
	private launchCompleted = false
	private launchPromise: Promise<unknown> | null = null
	private terminated = false
	/** Breakpoints per file path. DAP `setBreakpoints` replaces the full set for
	 *  a source, so we track all per-file breakpoints and resend on each add. */
	private readonly breakpoints = new Map<string, Array<{ line: number; condition?: string }>>()

	constructor(opts: DapSessionOptions) {
		this.id = randomUUID()
		this.adapter = opts.adapter
		this.cwd = opts.cwd
		this.client = opts.client
		this.timeoutMs = opts.timeoutMs ?? 30_000
	}

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	/** Launch the debuggee. Sends `launch` (with adapter-specific launchConfig
	 *  merged in) then `configurationDone` if the adapter supports it. Does NOT
	 *  block until a stop — the caller follows up with `waitForStop()` or
	 *  `continue()` as needed. */
	async launch(opts: DapSessionLaunchOptions): Promise<void> {
		if (this.launched) throw new Error("DAP session already launched")
		if (this.terminated) throw new Error("DAP session already terminated")

		const launchArgs: Record<string, unknown> = {
			type: this.adapter.launchType,
			request: "launch",
			name: "kimchi-dap",
			program: opts.program,
			cwd: opts.cwd,
			stopOnEntry: opts.stopOnEntry ?? false,
			...this.adapter.launchConfig,
		}
		if (opts.args && opts.args.length > 0) launchArgs.args = opts.args
		if (opts.env) launchArgs.env = opts.env

		// Fire the launch request WITHOUT awaiting — js-debug (and some other
		// adapters) defer the `launch` response until after the client sends
		// `configurationDone`. If we awaited here, we'd deadlock. The launch
		// response is awaited in completeLaunch() after configurationDone is sent.
		this.launchPromise = sendRequest(this.client, "launch", launchArgs, this.timeoutMs)
		this.launched = true
	}

	/** Send configurationDone to signal the adapter that the launch sequence is
	 *  complete and the debuggee may start running. Call this AFTER setting any
	 *  initial breakpoints. Idempotent. For adapters that defer the `launch`
	 *  response until after configurationDone (js-debug), this also awaits the
	 *  pending launch response. */
	async completeLaunch(): Promise<void> {
		if (!this.launched || this.launchCompleted) return
		this.launchCompleted = true
		if (this.client.capabilities?.supportsConfigurationDoneRequest) {
			await sendRequest(this.client, "configurationDone", {}, this.timeoutMs)
		}
		// Await the launch response (if launch() fired it without awaiting).
		// For adapters that respond immediately, this resolves instantly.
		if (this.launchPromise) await this.launchPromise
	}

	/** Terminate the debug session. Best-effort `terminate` request (if the
	 *  adapter supports it, short timeout), then unconditional SIGKILL. Safe to
	 *  call multiple times. */
	async terminate(): Promise<void> {
		if (this.terminated) return
		this.terminated = true
		this.client.terminated = true

		if (this.client.capabilities?.supportsTerminateRequest) {
			try {
				await sendRequest(this.client, "terminate", {}, Math.min(this.timeoutMs, 3000))
			} catch {
				// Adapter didn't cooperate — force kill below.
			}
		}
		try {
			this.client.proc.kill()
		} catch {
			// Process already exited — nothing to kill.
		}
	}

	// ---------------------------------------------------------------------------
	// Breakpoints
	// ---------------------------------------------------------------------------

	/** Set a breakpoint at `line` in `file`. DAP `setBreakpoints` replaces the
	 *  full set for a source, so we resend all tracked breakpoints for that file.
	 *  Returns the verified status of the breakpoint just set. */
	async setBreakpoint(file: string, line: number, condition?: string): Promise<Breakpoint> {
		// Clear the current stopped state — setting a breakpoint means the caller
		// wants to continue to the new breakpoint, not return the current stop.
		this.client.stoppedEvent = null
		const existing = this.breakpoints.get(file) ?? []
		existing.push({ line, condition })
		const response = await sendRequest(
			this.client,
			"setBreakpoints",
			{
				source: { path: file },
				breakpoints: existing.map((b) => ({ line: b.line, condition: b.condition })),
				lines: existing.map((b) => b.line),
				sourceModified: false,
			},
			this.timeoutMs,
		)
		const body = response as { breakpoints?: Breakpoint[] }
		this.breakpoints.set(file, existing)
		const breakpoints = body.breakpoints ?? []
		return breakpoints[breakpoints.length - 1] ?? { verified: false, message: "no breakpoint returned" }
	}

	// ---------------------------------------------------------------------------
	// Execution control
	// ---------------------------------------------------------------------------

	/** Resume execution and wait for the next stop. Returns the `stopped` event
	 *  describing why execution paused (breakpoint, step, exception, etc.). */
	async continue(): Promise<StoppedEvent> {
		return this.stepAndStop("continue")
	}

	/** Step into the next function call, waiting for the next stop. */
	async stepIn(): Promise<StoppedEvent> {
		return this.stepAndStop("stepIn")
	}

	/** Step over the next function call, waiting for the next stop. */
	async stepOver(): Promise<StoppedEvent> {
		return this.stepAndStop("next")
	}

	/** Step out of the current function, waiting for the next stop. */
	async stepOut(): Promise<StoppedEvent> {
		return this.stepAndStop("stepOut")
	}

	/** Block until the next `stopped` event arrives. Use after `launch()` (with
	 *  stopOnEntry:false and a pre-set breakpoint) to wait for the breakpoint hit.
	 *  Rejects on terminate or timeout. If already stopped, returns immediately. */
	async waitForStop(timeoutMs?: number): Promise<StoppedEvent> {
		if (this.client.stoppedEvent) return this.client.stoppedEvent
		return this.registerStopWaiter(timeoutMs).promise
	}

	// ---------------------------------------------------------------------------
	// Inspection
	// ---------------------------------------------------------------------------

	/** Returns the full call stack for the current thread (top frame is [0]).
	 *  Underlying DAP request: `stackTrace`. */
	async getStackFrame(): Promise<StackFrame[]> {
		// Use the stopped event's threadId if available — it's the most current.
		const threadId = this.client.stoppedEvent?.threadId ?? (await this.ensureThreadId())
		const body = await sendRequest(this.client, "stackTrace", { threadId }, this.timeoutMs)
		return (body as { stackFrames?: StackFrame[] }).stackFrames ?? []
	}

	/** Returns the scopes (Locals, Arguments, Registers, ...) for a frame.
	 *  Underlying DAP request: `scopes`. */
	async getScopes(frameId: number): Promise<Scope[]> {
		const body = await sendRequest(this.client, "scopes", { frameId }, this.timeoutMs)
		return (body as { scopes?: Scope[] }).scopes ?? []
	}

	/** Returns the child variables of a variablesReference (from a scope or
	 *  another variable). Underlying DAP request: `variables`. */
	async getVariables(variablesReference: number): Promise<Variable[]> {
		const body = await sendRequest(this.client, "variables", { variablesReference }, this.timeoutMs)
		return (body as { variables?: Variable[] }).variables ?? []
	}

	/** Evaluate an expression in the context of a frame (or the global context
	 *  if frameId is omitted). Returns the stringified result + a
	 *  variablesReference for expanding structured values. */
	async evaluate(expression: string, frameId?: number): Promise<DapEvaluateResult> {
		const args: Record<string, unknown> = { expression, context: "repl" }
		if (frameId != null) args.frameId = frameId
		const body = await sendRequest(this.client, "evaluate", args, this.timeoutMs)
		const result = body as DapEvaluateResult
		if (!result || typeof result.result !== "string") {
			throw new Error("DAP evaluate returned no result")
		}
		return result
	}

	// ---------------------------------------------------------------------------
	// Accessors (for Layer 2 composed tools)
	// ---------------------------------------------------------------------------

	get isLaunched(): boolean {
		return this.launched
	}
	get isTerminated(): boolean {
		return this.terminated
	}
	get threadId(): number | null {
		return this.client.threadId
	}
	get capabilities(): DapCapabilities | null {
		return this.client.capabilities
	}
	get outputLines(): readonly DapOutputLine[] {
		return this.client.outputLines
	}

	// ---------------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------------

	/** Resolve the current thread id. If the client doesn't have one (no
	 *  stopped/thread event yet), query the `threads` request and pick the first.
	 *  Retries briefly if the adapter reports no threads yet (the debuggee
	 *  may not have started — observed with js-debug where `threads` returns
	 *  empty immediately after `configurationDone`). */
	private async ensureThreadId(): Promise<number> {
		if (this.client.threadId != null) return this.client.threadId
		// A `stopped` or `thread` event may arrive between retries and set
		// client.threadId — check it on each attempt.
		for (let attempt = 0; attempt < 20; attempt++) {
			if (this.client.threadId != null) return this.client.threadId
			const body = await sendRequest(this.client, "threads", {}, this.timeoutMs)
			const threads = (body as { threads?: Thread[] }).threads ?? []
			if (threads.length > 0) {
				this.client.threadId = threads[0].id
				return threads[0].id
			}
			// Wait 50ms before retrying — give the adapter time to start the debuggee.
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
		throw new Error("DAP adapter reported no debuggee threads after retries")
	}

	/** Shared continue/step implementation: register a stop waiter, send the
	 *  request, await the stop. If the request itself fails, cancel the waiter so
	 *  it doesn't hang until timeout. */
	private async stepAndStop(command: "continue" | "stepIn" | "stepOut" | "next"): Promise<StoppedEvent> {
		// If the launch sequence hasn't been completed (configurationDone not yet
		// sent — e.g. Layer 1 debug_launch + debug_continue flow), do it now.
		// Skip the await entirely if already completed to avoid yielding control
		// (which could let a terminated event be processed before the stop waiter
		// is registered — a race observed in session.test.ts).
		if (!this.launchCompleted) await this.completeLaunch()

		// Clear the current stopped state — we're about to resume execution.
		this.client.stoppedEvent = null
		const threadId = await this.ensureThreadId()
		const { promise, cancel } = this.registerStopWaiter()
		try {
			await sendRequest(this.client, command, { threadId }, this.timeoutMs)
		} catch (err) {
			// For `continue`: if the adapter rejects the request because the
			// program is already running (e.g. after configurationDone started
			// it), don't cancel the stop waiter — the program is still executing
			// and will hit a breakpoint or terminate. The waiter will resolve
			// when the next stop event arrives.
			const msg = (err as Error).message
			if (command === "continue" && /Unable to process|already running/i.test(msg)) {
				return promise
			}
			cancel(err as Error)
			throw err
		}
		return promise
	}

	/** Push a stopped + terminated waiter onto the client and return the stop
	 *  promise plus a cancel function (for stepAndStop to abort on send error).
	 *  The waiter is removed from the client arrays on resolve/reject/timeout
	 *  so it can't be double-resolved by a later event. */
	private registerStopWaiter(timeoutMs?: number): {
		promise: Promise<StoppedEvent>
		cancel: (err: Error) => void
	} {
		const deadline = timeoutMs ?? this.timeoutMs
		if (this.client.terminated) {
			return {
				promise: Promise.reject(new Error("DAP session already terminated")),
				cancel: () => {},
			}
		}

		let rejectFn: ((err: Error) => void) | null = null
		let stoppedWaiter: DapStoppedWaiter | null = null
		let terminatedWaiter: DapTerminatedWaiter | null = null
		let timer: ReturnType<typeof setTimeout> | null = null

		const removeWaiters = () => this.removeWaiters(stoppedWaiter, terminatedWaiter)

		const promise = new Promise<StoppedEvent>((resolve, reject) => {
			rejectFn = reject
			timer = setTimeout(() => {
				removeWaiters()
				reject(new Error(`Timed out waiting for DAP stop after ${deadline}ms`))
			}, deadline)

			stoppedWaiter = {
				resolve: (event) => {
					if (timer) clearTimeout(timer)
					removeWaiters()
					resolve(event)
				},
				reject: (err) => {
					if (timer) clearTimeout(timer)
					removeWaiters()
					reject(err)
				},
			}
			terminatedWaiter = {
				resolve: () => {
					if (timer) clearTimeout(timer)
					removeWaiters()
					reject(new Error("Debuggee terminated before reaching a stop"))
				},
				reject: (err) => {
					if (timer) clearTimeout(timer)
					removeWaiters()
					reject(err)
				},
			}

			this.client.stoppedWaiters.push(stoppedWaiter)
			this.client.terminatedWaiters.push(terminatedWaiter)
		})

		const cancel = (err: Error) => {
			if (timer) clearTimeout(timer)
			removeWaiters()
			if (rejectFn) rejectFn(err)
		}

		return { promise, cancel }
	}

	private removeWaiters(stopped: DapStoppedWaiter | null, terminated: DapTerminatedWaiter | null): void {
		if (stopped) {
			const i = this.client.stoppedWaiters.indexOf(stopped)
			if (i >= 0) this.client.stoppedWaiters.splice(i, 1)
		}
		if (terminated) {
			const i = this.client.terminatedWaiters.indexOf(terminated)
			if (i >= 0) this.client.terminatedWaiters.splice(i, 1)
		}
	}
}

// =============================================================================
// Session registry (module-level, keyed by sessionId)
// =============================================================================

const sessions = new Map<string, DapSession>()

/** Create and register a new DapSession. The session is tracked by id so
 *  Layer 1 tools (which receive a sessionId) can look it up. */
export function createSession(opts: DapSessionOptions): DapSession {
	const session = new DapSession(opts)
	sessions.set(session.id, session)
	return session
}

/** Look up a session by id (used by Layer 1 tools to route by sessionId). */
export function getSession(id: string): DapSession | undefined {
	return sessions.get(id)
}

/** Remove a session from the registry (after terminate). */
export function removeSession(id: string): void {
	sessions.delete(id)
}

/** All registered sessions (active + terminated). Used by status reporting. */
export function getActiveSessions(): DapSession[] {
	return Array.from(sessions.values())
}

/** Clear all sessions — called on session_shutdown before shutdownAll kills
 *  the underlying clients. Prevents stale references after a session reset. */
export function clearAllSessions(): void {
	sessions.clear()
}
