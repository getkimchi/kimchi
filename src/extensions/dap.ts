// extensions/dap.ts
/**
 * DAP (Debug Adapter Protocol) Extension
 *
 * Gives the agent runtime debugger access via DAP. Supports TypeScript/JavaScript
 * (js-debug), Python (debugpy), Go (dlv dap), and native (lldb-dap).
 *
 * Modeled on extensions/lsp.ts: detects adapters on session_start, sets a status
 * footer, registers Layer 1 primitive tools, and tears down on session_shutdown.
 * Layer 2 composed tools (debug_state_at, debug_trace_calls, etc.) are added
 * in a later phase.
 *
 * Usage: kimchi -e extensions/dap.ts
 */
import path from "node:path"
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { adapterForFile, allAdapters, detectAdapters, detectMissingAdapters } from "./dap/adapters.js"
import { getOrCreateClient, shutdownAll } from "./dap/client.js"
import { clearAllSessions, createSession, getSession } from "./dap/session.js"
import { createLayer1Tools, createLayer2Tools, type LaunchSessionOptions } from "./dap/tools.js"
import { createSystemPromptBlocks } from "./prompt-construction/index.js"
import { createToolVisibility } from "./prompt-construction/tool-visibility.js"
import { getCurrentPhase } from "./tags.js"

const DAP_SYSTEM_PROMPT = `## Debugger (DAP)

DAP tools give you a live debugger. Use them to get **ground-truth runtime values** and trace **actual execution flow** — this is faster and more reliable than reasoning about behavior by reading code or writing repro scripts.

**Stop reasoning and use the debugger when you catch yourself:**
- Tracing variable values through code by hand ("if generation is 1 here, then after the loop it becomes...") → use \`debug_state_at\` to see the actual value at that line
- Wondering which code path runs or in what order → use \`debug_trace_calls\` to get the real call sequence
- Writing a throwaway repro script to test a hypothesis about runtime behavior → \`debug_state_at\` or \`debug_watch_change\` will show you the value directly, no script needed
- Adding \`console.log\` / \`fmt.Println\` / \`print()\` to see a value → \`debug_state_at\` with \`evaluated\` gives you the exact value at a breakpoint, with no code to clean up
- Guessing why a program panics or throws → \`debug_last_error\` captures the exception, locals at the throw site, and the backtrace in one call

A single \`debug_state_at\` call collapses an entire read→reason→repro→re-run cycle into one step. The debugger shows you what *actually happened*, not what you *think should happen*.

**When to use which tool:**
- "What is the value of X at line N?" → \`debug_state_at({file, line, evaluated: ["X"]})\`
- "Why does this throw and what is the state when it does?" → \`debug_last_error({program})\`
- "Which functions actually run and in what order?" → \`debug_trace_calls({program})\`
- "How does this value change as the program steps?" → \`debug_watch_change({file, line, expression})\`
- "I need to step through interactively" → Layer 1 tools (launch → set_breakpoint → continue → locals → step → terminate)

**Layer 2 composed tools** (preferred — one call handles the full launch→breakpoint→inspect→terminate lifecycle):
- \`debug_state_at({file, line, evaluated?})\` — set a breakpoint, run to it, return locals + backtrace + evaluated expressions + captured stdout/stderr. Auto-launches and terminates a session if no \`session_id\` is given.
- \`debug_last_error({program})\` — run until throw; return exception type/message + locals at the throw site + backtrace. Returns null if the program completes without throwing.
- \`debug_trace_calls({program})\` — structured call records (function name, args, return value) via sentinel-prefixed logMessage parsing.
- \`debug_watch_change({file, line, expression})\` — watch an expression for changes; returns change locations with old/new values.

**Layer 1 primitive tools** (interactive stepping when you need fine control):
- \`debug_launch({program})\` → returns \`session_id\`
- \`debug_set_breakpoint({session_id, file, line})\` → set a breakpoint
- \`debug_continue({session_id})\` → run to next stop
- \`debug_locals({session_id})\` / \`debug_eval({session_id, expression})\` → inspect values (requires a stopped session)
- \`debug_backtrace({session_id})\` → call stack
- \`step_in\` / \`step_over\` / \`step_out\` → step through code
- \`debug_terminate({session_id})\` → always clean up when done

The adapter is auto-detected from the program file extension (.ts/.js→js-debug, .go→dlv, .py→debugpy, .rs/.c→lldb-dap).`

// All DAP tool names (Layer 1 + Layer 2). Used to toggle visibility based on
// the current orchestrator phase — DAP tools are hidden during explore/plan
// (read-only/discovery phases) and shown during build/review.
const DAP_TOOL_NAMES = [
	"debug_launch",
	"debug_set_breakpoint",
	"debug_continue",
	"debug_locals",
	"debug_eval",
	"debug_backtrace",
	"debug_terminate",
	"step_in",
	"step_over",
	"step_out",
	"debug_state_at",
	"debug_last_error",
	"debug_trace_calls",
	"debug_watch_change",
] as const

const DAP_VISIBLE_PHASES: ReadonlySet<string> = new Set(["build", "review"])

export default function (pi: ExtensionAPI) {
	let cwd = ""
	let activeAdapters = detectAdapters("")
	let missingAdapters = detectMissingAdapters("")
	let warned = false
	let ui: ExtensionUIContext | undefined
	// Phase-based tool visibility: DAP tools are hidden during explore/plan
	// (discovery phases where a debugger is unhelpful) and shown during
	// build/review. Polled per tool_call so transitions are picked up promptly.
	const visibility = createToolVisibility(pi)
	let lastPhase: string | undefined

	createSystemPromptBlocks(pi, "dap").register({
		id: "dap-tools",
		render: () => (activeAdapters.length > 0 ? DAP_SYSTEM_PROMPT : undefined),
	})

	// ── Session start: detect adapters, set status footer, register tools ───────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd
		ui = ctx.hasUI ? ctx.ui : undefined
		warned = false
		activeAdapters = detectAdapters(cwd)
		missingAdapters = detectMissingAdapters(cwd)

		updateStatusFooter()

		// Register Layer 1 tools (idempotent — registerTool replaces by name).
		// Deps are wired here so tools.ts stays free of extension wiring.
		const deps = {
			cwd,
			getSession: (id: string) => getSession(id),
			launchSession: (opts: LaunchSessionOptions) => launchSession(opts),
		}
		for (const tool of createLayer1Tools(deps)) {
			pi.registerTool(tool)
		}
		// Register Layer 2 composed tools (debug_state_at, debug_last_error,
		// debug_trace_calls, debug_watch_change). Same deps — they share the
		// session registry and launchSession helper.
		for (const tool of createLayer2Tools(deps)) {
			pi.registerTool(tool)
		}
	})

	pi.on("session_shutdown", async () => {
		clearAllSessions()
		shutdownAll()
		if (ui) {
			ui.setStatus("dap", undefined)
			ui = undefined
		}
		warned = false
	})

	// ── Phase-based tool visibility: poll getCurrentPhase per tool_call ──────────
	// Mirrors the review-write-guard pattern. When the phase transitions into
	// explore/plan, disable DAP tools; when it transitions into build/review,
	// re-enable them. Idempotent via the lastPhase cache.
	pi.on("tool_call", (_event, ctx) => {
		// Recover UI if not available at session_start (same pattern as LSP).
		if (!ui && ctx.hasUI) ui = ctx.ui

		const sessionId = ctx.sessionManager.getSessionId()
		const phase = getCurrentPhase(sessionId)
		if (phase === lastPhase) return
		lastPhase = phase
		const shouldShow = phase === undefined || DAP_VISIBLE_PHASES.has(phase)
		if (shouldShow) {
			visibility.enable(DAP_TOOL_NAMES)
		} else {
			visibility.disable(DAP_TOOL_NAMES)
		}
	})

	// ── Degraded-state warning: notify once on the first agent turn ─────────────

	pi.on("before_agent_start", async (_event, ctx) => {
		// UI may not be available at session_start — recover it here.
		if (!ui && ctx.hasUI) ui = ctx.ui
		updateStatusFooter()

		if (warned || missingAdapters.length === 0 || !ui?.notify) return
		const lines = missingAdapters.map((a) => `${a.name} — install with: ${a.installHint ?? a.command}`)
		ui.notify(`DAP unavailable: debug adapter(s) not installed for this project.\n${lines.join("\n")}`, "warning")
		warned = true
	})

	// ── Helpers ─────────────────────────────────────────────────────────────────

	function updateStatusFooter(): void {
		if (!ui) return
		if (activeAdapters.length === 0 && missingAdapters.length === 0) {
			ui.setStatus("dap", undefined)
			return
		}
		if (missingAdapters.length > 0) {
			const missingNames = missingAdapters.map((a) => a.name).join(", ")
			if (activeAdapters.length > 0) {
				const activeNames = activeAdapters.map((a) => a.name).join(", ")
				ui.setStatus("dap", `DAP: ${activeNames} · ${missingNames} not installed`)
			} else {
				ui.setStatus("dap", `DAP: ${missingNames} not installed`)
			}
		} else {
			const names = activeAdapters.map((a) => a.name).join(", ")
			ui.setStatus("dap", `DAP: ${names}`)
		}
	}

	/** Resolve a program path to an absolute path (relative to session cwd). */
	function resolvePath(p: string): string {
		return path.isAbsolute(p) ? p : path.join(cwd, p)
	}

	/** Launch a debug session: resolve the adapter, connect the DapClient, create
	 *  the DapSession, and call session.launch(). Used by the debug_launch tool. */
	async function launchSession(opts: LaunchSessionOptions) {
		const program = resolvePath(opts.program)

		// Resolve adapter by explicit name or by program file extension.
		// allAdapters() returns the full static registry; getOrCreateClient
		// will surface a clear error if the binary isn't installed.
		const adapters = allAdapters()
		const adapter = opts.adapterName
			? (adapters.find((a) => a.name === opts.adapterName) ?? null)
			: adapterForFile(program, adapters)

		if (!adapter) {
			const supportedExts = allAdapters()
				.flatMap((a) => a.extensions.map((e) => `.${e}`))
				.join(", ")
			throw new Error(
				`No DAP adapter available for ${
					opts.adapterName ? `adapter "${opts.adapterName}"` : `file ${opts.program}`
				}. Supported file extensions: ${supportedExts}. ` +
					"Tip: Use debug_state_at({file, line}) which auto-detects the adapter and manages the session lifecycle in one call.",
			)
		}

		const client = await getOrCreateClient(adapter, cwd)
		const session = createSession({ adapter, cwd, client })
		await session.launch({
			program,
			cwd,
			args: opts.args,
			stopOnEntry: opts.stopOnEntry,
			env: opts.env,
		})
		return session
	}
}
