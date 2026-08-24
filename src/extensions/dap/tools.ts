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
	/** Remove a session from the registry after it has been terminated, so
	 *  terminated sessions do not accumulate until session shutdown. */
	removeSession: (id: string) => void
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

/** Complete example flow shown in error hints. Kept short so it fits in a
 *  tool result without overwhelming the context window. */
const USAGE_EXAMPLE = `Example flow:
  1. debug_launch(program="/src/app.ts")  → returns session_id
  2. debug_set_breakpoint(session_id=..., file="/src/app.ts", line=42)
  3. debug_continue(session_id=...)   → runs to the breakpoint
  4. debug_locals(session_id=...)      → inspect variable values
  5. debug_terminate(session_id=...)   → always clean up`

/** Error categories and the hint that helps the model recover. Each entry
 *  is a substring test on the error message. Order matters: the first match
 *  wins, so put more-specific patterns before general ones. */
const ERROR_HINTS: ReadonlyArray<{ match: RegExp; hint: string }> = [
	{
		match: /No DAP session found for sessionId/i,
		hint: `You need an active debug session first. Call debug_launch with the program path, then use the returned session_id for this tool.\n${USAGE_EXAMPLE}`,
	},
	{
		match: /No DAP adapter available for/i,
		hint: "Check that the correct adapter is installed and on PATH, or specify the adapter explicitly via debug_launch's `adapter` parameter. See the adapter's installHint for setup instructions.",
	},
	{
		match: /DAP adapter exited \(code null\)/i,
		hint: "The adapter subprocess was killed unexpectedly. Verify the binary is installed, is the correct version, and is on PATH. Check the adapter's installHint.",
	},
	{
		match: /DAP adapter exited/i,
		hint: "The adapter subprocess exited unexpectedly. Verify the binary is installed and is the correct version. Check the adapter's installHint for setup instructions.",
	},
	{
		match: /no debuggee threads/i,
		hint: "The program may have terminated before you could inspect it. Verify the breakpoint line is reachable and the program actually reaches that code path. Use debug_state_at for the common case — it sets the breakpoint before launching to avoid this race.",
	},
	{
		match: /No stack frames available/i,
		hint: "Inspection tools (debug_locals, debug_backtrace, debug_eval) require a stopped session. Call debug_continue or a step tool first to reach a breakpoint, then inspect.",
	},
	{
		match: /Composed operation timed out/i,
		hint: "The program did not stop within the timeout — it may be in an infinite loop, or the breakpoint line is never reached. Verify the line number and that the breakpoint is on executable code. Pass a larger timeout_ms if the program legitimately needs more time.",
	},
	{
		match: /DAP (continue|stepIn|stepOut|next) failed/i,
		hint: "The adapter rejected the continue/step request. This usually means the session is not in a stopped state (already running or terminated). Check debug_continue's last result — if the program terminated, launch a new session.",
	},
	{
		match: /DAP evaluate returned no result/i,
		hint: "The adapter could not evaluate the expression. Verify the expression is valid for the debuggee language and that the session is stopped at a breakpoint (evaluation requires a paused frame).",
	},
	{
		match: /DAP evaluate failed/i,
		hint: "The adapter rejected the expression. For Go/dlv: method calls (e.g. cache.lru.Len()) and field access on unexported fields (lowercase names like 'lru', 'items') may fail. Try: (1) evaluate just the variable name (e.g. 'cache') to see its struct fields, (2) use debug_locals to see variable values directly, (3) simplify the expression.",
	},
	{
		match: /DAP setBreakpoints failed/i,
		hint: "The adapter could not set the breakpoint. Verify the file path is absolute (or cwd-relative) and the line number is within the file. Some adapters reject breakpoints on non-executable lines (comments, blank lines).",
	},
	{
		match: /Debuggee terminated before reaching a stop/i,
		hint: "The program ran to completion without hitting a breakpoint. Verify the breakpoint line is on executable code that the program actually reaches. Use debug_set_breakpoint BEFORE debug_continue. Tip: Use debug_state_at instead — it sets the breakpoint before launching, avoiding this race.",
	},
	{
		match: /Breakpoint unverified/i,
		hint: "The adapter could not set the breakpoint at that line. This usually means the line is not executable (comments, blank lines) or the program has already exited. Verify the file path is absolute and the line number has executable code.",
	},
	{
		match: /DAP launch failed/i,
		hint: "The adapter could not launch the program. Verify the program path is correct, the file exists, and the adapter matches the language (e.g. dlv for .go, js-debug for .ts/.js). Check the adapter's installHint.",
	},
]

/** Format an error message with an actionable hint when we recognize the
 *  error category. Unrecognized errors pass through unchanged (just the
 *  `Error:` prefix) — we don't want to add noise for errors we can't
 *  meaningfully improve. */
function formatDapError(message: string): string {
	for (const { match, hint } of ERROR_HINTS) {
		if (match.test(message)) {
			return `Error: ${message}\n\nHint: ${hint}`
		}
	}
	return `Error: ${message}`
}

function errorResult(message: string): ToolTextResult {
	return { content: [{ type: "text", text: formatDapError(message) }], details: null }
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

const SetVariableSchema = Type.Object({
	session_id: Type.String({ description: "DAP session id returned by debug_launch" }),
	variables_reference: Type.Number({
		description: "Variables reference from debug_locals or debug_eval (the parent scope/variable)",
	}),
	name: Type.String({ description: "Variable name to set" }),
	value: Type.String({ description: "New value (as a string expression)" }),
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
	program: Type.Optional(
		Type.String({
			description:
				"Program to launch. Defaults to `file` — correct for interpreted languages (Node, Python, Go). For compiled languages (C/C++/Rust), pass the built binary and set `file` to the source file.",
		}),
	),
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

/** Cap on debug_locals output lines — huge structs would otherwise flood the
 *  tool result and the agent's context. */
const MAX_LOCALS_LINES = 100

// =============================================================================
// Tool definitions
// =============================================================================

/** Layer 1 primitive tools — one DAP request per call, no composed
 *  orchestration. step_in/step_over/step_out keep the step_* prefix (rather
 *  than debug_*) deliberately: `step` is the natural verb for LLM tool choice,
 *  and the skill-injection trigger in dap.ts matches both prefixes. */
export function createLayer1Tools(deps: DapToolDeps): ToolDefinition[] {
	return [
		// ── debug_launch ────────────────────────────────────────────────────
		{
			name: "debug_launch",
			label: "DAP: Launch Debug Session",
			description:
				"Launch a debug session for a program. Returns a session id to use with other debug_* tools. The program does NOT start running until you call debug_continue — so you can set breakpoints with debug_set_breakpoint after launching. Workflow: (1) debug_launch, (2) debug_set_breakpoint, (3) debug_continue → stops at breakpoint, (4) debug_locals/debug_eval, (5) debug_terminate. Auto-detects the adapter from the file extension (.ts/.js→js-debug, .py→debugpy, .go→dlv, .rs/.c→lldb-dap). For Go package directories, pass the directory path and set adapter='dlv'. Tip: For one-off state inspection, prefer debug_state_at instead — it handles launch+breakpoint+inspect+terminate in one call.",
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
			description:
				"Set a breakpoint at a line in a file. Call this AFTER debug_launch and BEFORE debug_continue. Returns the verified status — if unverified, the line may not be executable code.",
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
				"Resume execution and wait for the next stop (breakpoint, exception, or pause). Returns the stop reason and location. Set breakpoints with debug_set_breakpoint BEFORE calling this — otherwise the program may run to completion without stopping. If the program terminates, the error will say 'Debuggee terminated'.",
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
				"Get local variables at the current stop or a specific frame. Returns variable names, values, and types. Variables with expandable children include a [ref N] marker — pass that ref as variables_reference to debug_set_variable to mutate them (references are valid only while the debuggee is paused at the current stop).",
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
							const ref = v.variablesReference > 0 ? ` [ref ${v.variablesReference}]` : ""
							lines.push(`${v.name} = ${v.value}${type}${ref}`)
							// Expand one level of nested variables (struct fields, slice
							// elements) so the agent can inspect object fields without
							// needing debug_eval (which fails on unexported fields in Go).
							if (v.variablesReference > 0) {
								const children = await session.getVariables(v.variablesReference)
								for (const child of children) {
									const childType = child.type ? ` (${child.type})` : ""
									const childRef = child.variablesReference > 0 ? ` [ref ${child.variablesReference}]` : ""
									lines.push(`  ${v.name}.${child.name} = ${child.value}${childType}${childRef}`)
								}
							}
						}
					}
					if (lines.length > MAX_LOCALS_LINES) {
						lines.length = MAX_LOCALS_LINES
						lines.push(`  [truncated at ${MAX_LOCALS_LINES} lines — use debug_eval to inspect specific variables]`)
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
				"Evaluate an expression in the context of a frame (or the global context). Returns the stringified result. Structured results include a [ref N] marker you can pass as variables_reference to debug_set_variable (references are valid only while paused at the current stop). Use this to inspect variable values at a breakpoint — e.g. debug_eval(session_id, 'entry.generation') shows the actual runtime value instead of tracing it through code by hand. Supported expressions vary by adapter: for Go/dlv, field access works (e.g. 'cache.capacity', 'cache.items', 'cache.lru') and built-in functions work (e.g. 'len(cache.items)') but method calls on unexported fields fail (e.g. 'cache.lru.Len()'). If an expression fails, try evaluating just the variable name to see its fields, then use debug_locals to inspect them directly.",
			promptSnippet: "Get the actual runtime value of an expression at a breakpoint",
			parameters: EvalSchema,
			async execute(_toolCallId, params: Static<typeof EvalSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					const frameId = params.frame_id ?? (await getTopFrameId(session))
					const result = await session.evaluate(params.expression, frameId)
					const type = result.type ? ` (${result.type})` : ""
					const ref = result.variablesReference > 0 ? ` [ref ${result.variablesReference}]` : ""
					return textResult(`${result.result}${type}${ref}`)
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
					deps.removeSession(params.session_id)
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
		// ── debug_set_variable ─────────────────────────────────────────────
		{
			name: "debug_set_variable",
			label: "DAP: Set Variable",
			description:
				"Set a variable's value at runtime. Useful for testing hypotheses — \"what if this value were 42?\" Requires a variablesReference from debug_locals output. The variable is modified in the debuggee's memory.",
			promptSnippet: "Set a variable value at runtime to test a hypothesis",
			parameters: SetVariableSchema,
			async execute(_toolCallId, params: Static<typeof SetVariableSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					const result = await session.setVariable(params.variables_reference, params.name, params.value)
					return textResult(`Set ${params.name} = ${result.value}`)
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Set Variable"),
		},
		// ── debug_restart ──────────────────────────────────────────────────
		{
			name: "debug_restart",
			label: "DAP: Restart Session",
			description:
				"Restart the debug session. Faster than terminate + launch for iterative debugging. Only works if the adapter supports restart (supportsRestartRequest capability).",
			promptSnippet: "Restart the debug session for faster iteration",
			parameters: SessionIdSchema,
			async execute(_toolCallId, params: Static<typeof SessionIdSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const session = requireSession(deps, params.session_id)
					await session.restart()
					return textResult(`Session ${params.session_id} restarted.`)
				} catch (err) {
					return errorResult((err as Error).message)
				}
			},
			renderCall: dapRenderCall("DAP: Restart Session"),
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
				"Get the actual runtime value of variables at a specific line — faster than writing a repro or reasoning through code. Sets a breakpoint at file:line, runs to it, and returns locals (with one level of nested struct fields), backtrace, evaluated expressions, and stdout/stderr. Use the `evaluated` parameter to inspect specific expressions. For Go/dlv: field access works (e.g. 'cache.capacity', 'cache.items', 'cache.lru') and built-in functions work (e.g. 'len(cache.items)'), but method calls on unexported fields fail (e.g. 'cache.lru.Len()'). If evaluation fails, just pass the variable name and inspect its fields in the locals output. Auto-launches and terminates a session if no session_id is given.",
			promptSnippet: "Get actual runtime values at a breakpoint (replaces repro scripts)",
			parameters: StateAtSchema,
			async execute(_toolCallId, params: Static<typeof StateAtSchema>, _signal, _onUpdate, _ctx: ExtensionContext) {
				try {
					const result = await debugStateAt(deps, {
						sessionId: params.session_id,
						file: params.file,
						program: params.program,
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
				"Find out why a program throws and what local state caused it — no need to add logging or reason about the error path. Runs the program until it throws, then returns the exception type/message, locals at the throw site, backtrace, and stdout/stderr. Returns null if the program completes without throwing.",
			promptSnippet: "Run until exception and capture throw-site state",
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
				"Collect pre-instrumented trace output. IMPORTANT: this tool does NOT instrument anything for you — it only parses lines the program already prints. It runs the program to completion and extracts structured call records (function name, args, return value) from __KIMCHI_TRACE__ JSON sentinels the program explicitly logs itself (e.g. console.log('__KIMCHI_TRACE__' + JSON.stringify({fn, args, result}))). If the program prints no such markers, the result says 'not instrumented' — add markers or use debug_state_at/debug_watch_change instead.",
			promptSnippet: "Get the actual call sequence (replaces reading code to trace flow)",
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
				"See how a variable's value changes as the program steps — replaces adding print statements to observe mutations. Sets a breakpoint at file:line, then steps through watching an expression for value changes. Returns each change location with old/new values.",
			promptSnippet: "Watch a variable change across steps (replaces print statements)",
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
	if (r.calls.length === 0) {
		return (
			"No trace calls captured — program is NOT INSTRUMENTED. " +
			"This tool only parses pre-existing __KIMCHI_TRACE__ markers; it does not inject any. " +
			"To trace calls, add markers like console.log('__KIMCHI_TRACE__' + JSON.stringify({fn, args, result})) " +
			"at the functions of interest, or use debug_state_at / debug_watch_change instead."
		)
	}
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
	// formatStop stays synchronous (no getStackFrame await): the tool result
	// shows stop reason + threadId; the user can call debug_backtrace for the
	// frame details.
	const desc = event.description ? ` — ${event.description}` : ""
	return `Stopped: ${event.reason}${desc} (thread ${threadId})`
}
