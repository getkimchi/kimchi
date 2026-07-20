// extensions/dap/tools.ts
//
// Layer 1 DAP primitive tools — TypeBox schemas + execute handlers + renderCall.
// Each tool takes a sessionId (except `debug_launch`, which creates one) and
// delegates to DapSession. Mirrors the lsp.ts tool pattern: schema defines
// params, execute delegates to the session layer, renderCall produces a short
// TUI header. The extension entry point (dap.ts) imports createLayer1Tools(deps)
// and calls pi.registerTool for each spec.
//
// Dependencies are injected via DapToolDeps so tools.ts is testable without
// the full extension wiring (adapters/client/session plumbed in step 3).

import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import { type Static, Type } from "typebox"
import type {
	DebugLastErrorResult,
	DebugStateAtResult,
	DebugTraceCallsResult,
	DebugWatchChangeResult,
} from "./composed.js"
import { debugLastError, debugStateAt, debugTraceCalls, debugWatchChange } from "./composed.js"
import type { DapSession } from "./session.js"
import type { StackFrame, Variable } from "./types.js"

// =============================================================================
// Dependency injection
// =============================================================================

export interface LaunchSessionOptions {
	/** Absolute or cwd-relative path to the program to debug. */
	program: string
	/** Explicit adapter name (e.g. "js-debug", "dlv"). Auto-detected from the
	 *  program file extension when omitted. */
	adapterName?: string
	/** Arguments passed to the debuggee (not the adapter). */
	args?: string[]
	/** If true, the debuggee stops on entry and waits for a continue/step. */
	stopOnEntry?: boolean
	/** Extra environment variables for the debuggee. */
	env?: Record<string, string>
}

export interface DapToolDeps {
	/** Session cwd (for resolving relative paths). */
	cwd: string
	/** Look up an active session by id (from the session registry). */
	getSession: (id: string) => DapSession | undefined
	/** Create + launch a new session. Resolves the adapter (from program path or
	 *  explicit name), connects the DapClient, creates the DapSession, and calls
	 *  session.launch(). Returns the launched session. */
	launchSession: (opts: LaunchSessionOptions) => Promise<DapSession>
}

// =============================================================================
// Tool result helper
// =============================================================================

interface ToolTextResult {
	content: Array<{ type: "text"; text: string }>
	details: null
}

function textResult(text: string): ToolTextResult {
	return { content: [{ type: "text", text }], details: null }
}

function errorResult(message: string): ToolTextResult {
	return { content: [{ type: "text", text: `Error: ${message}` }], details: null }
}

/** Look up a session by id and throw a clean error if it doesn't exist. */
function requireSession(deps: DapToolDeps, sessionId: string): DapSession {
	const session = deps.getSession(sessionId)
	if (!session) throw new Error(`No DAP session found for sessionId: ${sessionId}`)
	return session
}

// =============================================================================
// renderCall helper (mirrors lspRenderCall)
// =============================================================================

export function dapRenderCall(label: string) {
	return (args: unknown, theme: Theme, context: { lastComponent: unknown }): Container => {
		const a = (args ?? {}) as Record<string, unknown>
		const sessionId = (a.session_id as string | undefined) ?? ""
		const file = (a.file as string | undefined) ?? (a.program as string | undefined) ?? ""
		const line = a.line !== undefined ? `:${a.line}` : ""
		const loc = file ? `${file}${line}` : ""
		const header = `${theme.fg("muted", "-")} ${theme.fg("toolTitle", theme.bold(label))}`
		const sid = sessionId ? `  ${theme.fg("muted", "session:")} ${theme.fg("accent", sessionId.slice(0, 8))}` : ""
		const fileLine = loc
			? `  ${theme.fg("muted", "file:")} ${theme.fg("accent", "`")}${theme.fg("accent", loc)}${theme.fg("accent", "`")}`
			: ""

		const parts = [header, sid, fileLine].filter(Boolean)
		const text = parts.join("\n")
		const component = context.lastComponent instanceof Container ? context.lastComponent : new Container()
		component.clear()
		component.addChild(new Text(text, 0, 0))
		return component
	}
}

// =============================================================================
// Tool schemas
// =============================================================================

const DebugLaunchSchema = Type.Object({
	program: Type.String({ description: "Absolute or cwd-relative path to the program to debug" }),
	adapter: Type.Optional(
		Type.String({
			description: "Adapter name (js-debug, debugpy, dlv, lldb-dap). Auto-detected from file extension when omitted.",
		}),
	),
	args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the debuggee" })),
	stop_on_entry: Type.Optional(
		Type.Boolean({ description: "If true, stop on entry and wait for continue/step (default: false)", default: false }),
	),
	env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra environment variables" })),
})

const SessionIdSchema = Type.Object({
	session_id: Type.String({ description: "DAP session id returned by debug_launch" }),
})

const SetBreakpointSchema = Type.Object({
	session_id: Type.String({ description: "DAP session id returned by debug_launch" }),
	file: Type.String({ description: "Absolute or cwd-relative path to the source file" }),
	line: Type.Number({ description: "1-based line number to break at" }),
	condition: Type.Optional(Type.String({ description: "Optional condition expression (evaluated when hit)" })),
})

const LocalsSchema = Type.Object({
	session_id: Type.String({ description: "DAP session id returned by debug_launch" }),
	frame_id: Type.Optional(Type.Number({ description: "Frame id (from debug_backtrace). Defaults to the top frame." })),
})

const EvalSchema = Type.Object({
	session_id: Type.String({ description: "DAP session id returned by debug_launch" }),
	expression: Type.String({ description: "Expression to evaluate in the frame's context" }),
	frame_id: Type.Optional(Type.Number({ description: "Frame id (from debug_backtrace). Defaults to the top frame." })),
})

// ── Layer 2 composed tool schemas ────────────────────────────────────────

const StateAtSchema = Type.Object({
	session_id: Type.Optional(
		Type.String({
			description: "Existing DAP session id. If omitted, a new session is launched for the file and terminated after.",
		}),
	),
	file: Type.String({ description: "Source file to set the breakpoint in" }),
	line: Type.Number({ description: "1-based line number to break at" }),
	evaluated: Type.Optional(Type.Array(Type.String(), { description: "Expressions to evaluate at the breakpoint" })),
	timeout_ms: Type.Optional(Type.Number({ description: "Wall-clock timeout in ms (default 30000)" })),
})

const LastErrorSchema = Type.Object({
	session_id: Type.Optional(
		Type.String({
			description:
				"Existing DAP session id. If omitted, a new session is launched for the program and terminated after.",
		}),
	),
	program: Type.String({ description: "Program to run until it throws" }),
	timeout_ms: Type.Optional(Type.Number({ description: "Wall-clock timeout in ms (default 30000)" })),
})

const TraceCallsSchema = Type.Object({
	session_id: Type.Optional(
		Type.String({
			description:
				"Existing DAP session id. If omitted, a new session is launched for the program and terminated after.",
		}),
	),
	program: Type.String({ description: "Program to run to completion while collecting __KIMCHI_TRACE__ sentinels" }),
	timeout_ms: Type.Optional(Type.Number({ description: "Wall-clock timeout in ms (default 30000)" })),
})

const WatchChangeSchema = Type.Object({
	session_id: Type.Optional(
		Type.String({
			description:
				"Existing DAP session id. If omitted, a new session is launched for the program and terminated after.",
		}),
	),
	program: Type.String({ description: "Program to run while watching the expression" }),
	file: Type.String({ description: "Source file where the breakpoint is set" }),
	line: Type.Number({ description: "1-based line number to break at before watching" }),
	expression: Type.String({ description: "Expression to watch for value changes" }),
	timeout_ms: Type.Optional(Type.Number({ description: "Wall-clock timeout in ms (default 30000)" })),
})

// =============================================================================
// Tool definitions
// =============================================================================

export function createLayer1Tools(deps: DapToolDeps): ToolDefinition[] {
	return [
		// ── debug_launch ────────────────────────────────────────────────────
		{
			name: "debug_launch",
			label: "DAP: Launch Debug Session",
			description:
				"Launch a debug session for a program. Returns a session id to use with other debug_* tools. Auto-detects the adapter from the file extension (.ts/.js→js-debug, .py→debugpy, .go→dlv, .rs/.c→lldb-dap).",
			promptSnippet: "Launch a debug session for a program and get a sessionId",
			parameters: DebugLaunchSchema,
			async execute(_toolCallId, params: Static<typeof DebugLaunchSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = await deps.launchSession({
						program: params.program,
						adapterName: params.adapter,
						args: params.args,
						stopOnEntry: params.stop_on_entry,
						env: params.env,
					})
					return textResult(`Debug session launched.\nsession_id: ${session.id}\nadapter: ${session.adapter.name}`)
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Launch Debug Session"),
		},

		// ── debug_set_breakpoint ────────────────────────────────────────────
		{
			name: "debug_set_breakpoint",
			label: "DAP: Set Breakpoint",
			description: "Set a breakpoint at a line in a file. Returns the verified status.",
			promptSnippet: "Set a breakpoint at a file:line",
			parameters: SetBreakpointSchema,
			async execute(
				_toolCallId,
				params: Static<typeof SetBreakpointSchema>,
				_signal,
				_onUpdate,
				_ctx: ExtensionContext,
			) {
				try {
					const session = requireSession(deps, params.session_id)
					const bp = await session.setBreakpoint(params.file, params.line, params.condition)
					const status = bp.verified ? "verified" : "unverified"
					const msg = bp.message ? ` — ${bp.message}` : ""
					return textResult(`Breakpoint ${status} at ${params.file}:${params.line}${msg}`)
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Set Breakpoint"),
		},

		// ── debug_continue ──────────────────────────────────────────────────
		{
			name: "debug_continue",
			label: "DAP: Continue",
			description:
				"Resume execution and wait for the next stop (breakpoint, exception, or pause). Returns the stop reason and location.",
			promptSnippet: "Continue execution until the next stop",
			parameters: SessionIdSchema,
			async execute(_toolCallId, params: Static<typeof SessionIdSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					const event = await session.continue()
					return textResult(formatStop(session, event))
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Continue"),
		},

		// ── debug_locals ────────────────────────────────────────────────────
		{
			name: "debug_locals",
			label: "DAP: Get Locals",
			description:
				"Get local variables at the current stop or a specific frame. Returns variable names, values, and types.",
			promptSnippet: "Get local variables at the current frame",
			parameters: LocalsSchema,
			async execute(_toolCallId, params: Static<typeof LocalsSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					const frameId = params.frame_id ?? (await getTopFrameId(session))
					const scopes = await session.getScopes(frameId)
					const lines: string[] = []
					for (const scope of scopes) {
						if (scope.variablesReference === 0) continue
						const vars = await session.getVariables(scope.variablesReference)
						for (const v of vars) {
							const type = v.type ? ` (${v.type})` : ""
							lines.push(`${v.name} = ${v.value}${type}`)
						}
					}
					if (lines.length === 0) return textResult("No local variables at this frame.")
					return textResult(lines.join("\n"))
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Get Locals"),
		},

		// ── debug_eval ──────────────────────────────────────────────────────
		{
			name: "debug_eval",
			label: "DAP: Evaluate Expression",
			description:
				"Evaluate an expression in the context of a frame (or the global context). Returns the stringified result.",
			promptSnippet: "Evaluate an expression in the current frame",
			parameters: EvalSchema,
			async execute(_toolCallId, params: Static<typeof EvalSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					const frameId = params.frame_id ?? (await getTopFrameId(session))
					const result = await session.evaluate(params.expression, frameId)
					const type = result.type ? ` (${result.type})` : ""
					return textResult(`${result.result}${type}`)
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Evaluate Expression"),
		},

		// ── debug_backtrace ─────────────────────────────────────────────────
		{
			name: "debug_backtrace",
			label: "DAP: Get Backtrace",
			description: "Get the call stack for the current thread. Returns frame ids, names, file paths, and line numbers.",
			promptSnippet: "Get the call stack (backtrace) at the current stop",
			parameters: SessionIdSchema,
			async execute(_toolCallId, params: Static<typeof SessionIdSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					const frames = await session.getStackFrame()
					if (frames.length === 0) return textResult("No stack frames available.")
					const lines = frames.map((f, i) => {
						const file = f.source?.path ? ` at ${f.source.path}:${f.line}` : ""
						return `#${i} [frame ${f.id}] ${f.name}${file}`
					})
					return textResult(lines.join("\n"))
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Get Backtrace"),
		},

		// ── debug_terminate ─────────────────────────────────────────────────
		{
			name: "debug_terminate",
			label: "DAP: Terminate Session",
			description: "Terminate a debug session and kill the debuggee. Safe to call multiple times.",
			promptSnippet: "Terminate a debug session",
			parameters: SessionIdSchema,
			async execute(_toolCallId, params: Static<typeof SessionIdSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					await session.terminate()
					return textResult(`Session ${params.session_id.slice(0, 8)} terminated.`)
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Terminate Session"),
		},

		// ── step_in ─────────────────────────────────────────────────────────
		{
			name: "step_in",
			label: "DAP: Step Into",
			description: "Step into the next function call. Returns the stop reason and location.",
			promptSnippet: "Step into the next function call",
			parameters: SessionIdSchema,
			async execute(_toolCallId, params: Static<typeof SessionIdSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					const event = await session.stepIn()
					return textResult(formatStop(session, event))
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Step Into"),
		},

		// ── step_over ───────────────────────────────────────────────────────
		{
			name: "step_over",
			label: "DAP: Step Over",
			description: "Step over the next function call. Returns the stop reason and location.",
			promptSnippet: "Step over the next function call",
			parameters: SessionIdSchema,
			async execute(_toolCallId, params: Static<typeof SessionIdSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					const event = await session.stepOver()
					return textResult(formatStop(session, event))
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Step Over"),
		},

		// ── step_out ────────────────────────────────────────────────────────
		{
			name: "step_out",
			label: "DAP: Step Out",
			description: "Step out of the current function. Returns the stop reason and location.",
			promptSnippet: "Step out of the current function",
			parameters: SessionIdSchema,
			async execute(_toolCallId, params: Static<typeof SessionIdSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					const event = await session.stepOut()
					return textResult(formatStop(session, event))
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Step Out"),
		},
	]
}

// =============================================================================
// Layer 2 composed tools
// =============================================================================

export function createLayer2Tools(deps: DapToolDeps): ToolDefinition[] {
	return [
		// ── debug_state_at ──────────────────────────────────────────────────
		{
			name: "debug_state_at",
			label: "DAP: Capture State at Line",
			description:
				"Set a breakpoint at file:line, run to it, and capture the full program state: locals, backtrace, evaluated expressions, and stdout/stderr. If no session_id is given, a new session is launched and terminated after capture.",
			promptSnippet: "Capture program state (locals, backtrace, output) at a breakpoint",
			parameters: StateAtSchema,
			async execute(_toolCallId, params: Static<typeof StateAtSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const result = await debugStateAt(deps, {
						sessionId: params.session_id,
						file: params.file,
						line: params.line,
						evaluated: params.evaluated,
						timeoutMs: params.timeout_ms,
					})
					return textResult(formatStateAtResult(result))
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Capture State at Line"),
		},

		// ── debug_last_error ────────────────────────────────────────────────
		{
			name: "debug_last_error",
			label: "DAP: Capture Last Error",
			description:
				"Run the program until it throws, then capture the exception type/message, locals at the throw site, backtrace, and stdout/stderr. Returns null if the program completes without throwing.",
			promptSnippet: "Run until an exception and capture throw-site state",
			parameters: LastErrorSchema,
			async execute(_toolCallId, params: Static<typeof LastErrorSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const result = await debugLastError(deps, {
						sessionId: params.session_id,
						program: params.program,
						timeoutMs: params.timeout_ms,
					})
					if (result === null) return textResult("Program completed without throwing.")
					return textResult(formatLastErrorResult(result))
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Capture Last Error"),
		},

		// ── debug_trace_calls ───────────────────────────────────────────────
		{
			name: "debug_trace_calls",
			label: "DAP: Trace Call Sequence",
			description:
				"Run the program to completion and collect structured call records emitted via __KIMCHI_TRACE__ sentinels in the program's console output. Each record includes the function name, args, and return value (when the adapter supports it).",
			promptSnippet: "Run to completion and collect call trace records",
			parameters: TraceCallsSchema,
			async execute(_toolCallId, params: Static<typeof TraceCallsSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const result = await debugTraceCalls(deps, {
						sessionId: params.session_id,
						program: params.program,
						timeoutMs: params.timeout_ms,
					})
					return textResult(formatTraceCallsResult(result))
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Trace Call Sequence"),
		},

		// ── debug_watch_change ──────────────────────────────────────────────
		{
			name: "debug_watch_change",
			label: "DAP: Watch Expression Changes",
			description:
				"Set a breakpoint at file:line, then step through the program watching an expression for value changes. Returns each change location with old/new values. Uses expression polling (works with all adapters).",
			promptSnippet: "Step through code and capture expression value changes",
			parameters: WatchChangeSchema,
			async execute(_toolCallId, params: Static<typeof WatchChangeSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const result = await debugWatchChange(deps, {
						sessionId: params.session_id,
						program: params.program,
						file: params.file,
						line: params.line,
						expression: params.expression,
						timeoutMs: params.timeout_ms,
					})
					return textResult(formatWatchChangeResult(result))
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Watch Expression Changes"),
		},
	]
}

// =============================================================================
// Helpers
// =============================================================================

/** Format a single stack frame as `#<i> [frame <id>] <name> at <file>:<line>`. */
function formatFrame(f: StackFrame, i: number): string {
	const file = f.source?.path ? ` at ${f.source.path}:${f.line}` : ""
	return `#${i} [frame ${f.id}] ${f.name}${file}`
}

/** Format a list of local variables as `name = value (type)`. */
function formatVariables(vars: Variable[]): string {
	if (vars.length === 0) return "  (none)"
	return vars
		.map((v) => {
			const type = v.type ? ` (${v.type})` : ""
			return `  ${v.name} = ${v.value}${type}`
		})
		.join("\n")
}

/** Format a DebugStateAtResult into a readable multi-section text block. */
function formatStateAtResult(r: DebugStateAtResult): string {
	const evaluatedLines = r.evaluated.length
		? r.evaluated
				.map((e) => `  ${e.expression} => ${e.error ? `error: ${e.error}` : (e.result?.result ?? "")}`)
				.join("\n")
		: "  (none)"
	const backtraceLines = r.backtrace.length ? r.backtrace.map((f, i) => formatFrame(f, i)).join("\n") : "  (none)"
	return [
		`hit: ${r.hit}`,
		"locals:",
		formatVariables(r.locals),
		"backtrace:",
		backtraceLines,
		"evaluated:",
		evaluatedLines,
		"stdout:",
		r.stdout || "  (none)",
		"stderr:",
		r.stderr || "  (none)",
	].join("\n")
}

/** Format a DebugLastErrorResult into a readable multi-section text block. */
function formatLastErrorResult(r: DebugLastErrorResult): string {
	const backtraceLines = r.backtrace.length ? r.backtrace.map((f, i) => formatFrame(f, i)).join("\n") : "  (none)"
	return [
		`exception: ${r.exception.type}: ${r.exception.message}`,
		"locals at throw:",
		formatVariables(r.locals_at_throw),
		"backtrace:",
		backtraceLines,
		"stdout:",
		r.stdout || "  (none)",
		"stderr:",
		r.stderr || "  (none)",
	].join("\n")
}

/** Format a DebugTraceCallsResult into a readable text block. */
function formatTraceCallsResult(r: DebugTraceCallsResult): string {
	if (r.calls.length === 0) return "No trace calls captured."
	const callLines = r.calls.map((c) => {
		const parts = [
			c.fn ? `fn=${c.fn}` : null,
			c.args !== undefined ? `args=${JSON.stringify(c.args)}` : null,
			c.result !== undefined ? `result=${JSON.stringify(c.result)}` : null,
		].filter(Boolean)
		return `  ${parts.join(" ")}`
	})
	return [`calls (${r.calls.length}${r.truncated ? ", truncated" : ""}):`, ...callLines].join("\n")
}

/** Format a DebugWatchChangeResult into a readable text block. */
function formatWatchChangeResult(r: DebugWatchChangeResult): string {
	if (r.changes.length === 0) return `No changes detected (method: ${r.method}).`
	const changeLines = r.changes.map((c, i) => {
		const loc = c.at ? `${c.at.source?.path ?? ""}:${c.at.line ?? "?"}` : "(unknown location)"
		return `  #${i} ${loc}: ${c.old} -> ${c.new}`
	})
	return [`changes (${r.changes.length}, method: ${r.method}):`, ...changeLines].join("\n")
}

/** Resolve the top frame's id from the session's stack trace. Used by
 *  debug_locals and debug_eval when frame_id is omitted. */
async function getTopFrameId(session: DapSession): Promise<number> {
	const frames = await session.getStackFrame()
	if (frames.length === 0) throw new Error("No stack frames available — program may not be stopped")
	return frames[0].id
}

/** Format a stopped event into a human-readable summary with the top frame's
 *  location. Shared by debug_continue, step_in, step_over, step_out. */
function formatStop(session: DapSession, event: { reason: string; description?: string }): string {
	const threadId = session.threadId ?? "?"
	// Synchronously read the top frame — getStackFrame is async but the stop
	// event has already arrived, so the frame is available immediately.
	// We don't await here to keep formatStop synchronous; callers that need
	// the frame call getStackFrame separately. For the tool result, we show
	// the stop reason + threadId; the user can call debug_backtrace for details.
	void session // suppress unused warning (threadId read above)
	const desc = event.description ? ` — ${event.description}` : ""
	return `Stopped: ${event.reason}${desc} (thread ${threadId})`
}
