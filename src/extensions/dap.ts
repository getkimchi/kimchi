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
import { readdirSync } from "node:fs"
import path from "node:path"
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { adapterForFile, allAdapters, detectAdapters, detectMissingAdapters } from "./dap/adapters.js"
import { getOrCreateClient, shutdownAll } from "./dap/client.js"
import { clearAllSessions, createSession, getSession } from "./dap/session.js"
import { createLayer1Tools, createLayer2Tools, type LaunchSessionOptions } from "./dap/tools.js"
import { createSystemPromptBlocks } from "./prompt-construction/index.js"

const DAP_SYSTEM_PROMPT = `## Debugger (DAP)

DAP tools give you a live debugger — your first tool for understanding runtime behavior, not a last resort. **Before you trace values by hand or write a repro script, check if the debugger can answer your question directly.** A breakpoint + \`debug_eval\` shows you the actual value in seconds and ~500 tokens; reasoning through code or building a repro takes minutes, ~50,000 tokens, and can still be wrong. The debugger is both faster and cheaper.

**Use the debugger instead of:**
- Tracing variable values through code by hand ("if generation is 1 here, then after the loop it becomes...") → \`debug_state_at({file, line, evaluated: ["var"]})\` shows the actual value at that line
- Writing a throwaway repro script to test a hypothesis → \`debug_state_at\` or \`debug_watch_change\` will show you the value directly, no script needed
- Adding \`console.log\` / \`fmt.Println\` / \`print()\` to see a value → \`debug_state_at\` with \`evaluated\` gives you the exact value at a breakpoint, with no code to clean up
- Guessing why a program panics or throws → \`debug_last_error\` captures the exception, locals at the throw site, and the backtrace in one call
- Reading code to figure out which path runs or in what order → \`debug_trace_calls\` returns the actual call sequence with arguments

The debugger shows you what *actually happened*, not what you *think should happen*. When you are about to reason about runtime behavior, ask: can the debugger answer this faster?

**Quick start — one call answers most questions:**
- "What is the value of X at line N?" → \`debug_state_at({file, line, evaluated: ["X"]})\`
- "Why does this throw and what is the state when it does?" → \`debug_last_error({program})\`
- "Which functions actually run and in what order?" → \`debug_trace_calls({program})\`
- "How does this value change as the program steps?" → \`debug_watch_change({file, line, expression})\`

**Layer 2 composed tools** (preferred — one call handles the full launch→breakpoint→inspect→terminate lifecycle):
- \`debug_state_at({file, line, evaluated?})\` — set a breakpoint, run to it, return locals + backtrace + evaluated expressions + captured stdout/stderr. Auto-launches and terminates a session if no \`session_id\` is given.
- \`debug_last_error({program})\` — run until throw; return exception type/message + locals at the throw site + backtrace. Returns null if the program completes without throwing.
- \`debug_trace_calls({program})\` — structured call records (function name, args, return value) via sentinel-prefixed logMessage parsing.
- \`debug_watch_change({file, line, expression})\` — watch an expression for changes; returns change locations with old/new values.

**Layer 1 primitive tools** (interactive stepping when you need fine control):
- \`debug_launch({program, adapter?})\` → returns \`session_id\`. For Go, pass a \`.go\` file or a package directory (e.g. \`./cmd/server\`); set \`adapter: "dlv"\` explicitly if the path has no extension.
- \`debug_set_breakpoint({session_id, file, line})\` → set a breakpoint
- \`debug_continue({session_id})\` → run to next stop
- \`debug_locals({session_id})\` / \`debug_eval({session_id, expression})\` → inspect values (requires a stopped session)
- \`debug_backtrace({session_id})\` → call stack
- \`step_in\` / \`step_over\` / \`step_out\` → step through code
- \`debug_terminate({session_id})\` → always clean up when done

The adapter is auto-detected from the program file extension (.ts/.js→js-debug, .go→dlv, .py→debugpy, .rs/.c→lldb-dap). For Go package directories, the adapter is detected from the presence of \`.go\` files in the directory.`

export default function (pi: ExtensionAPI) {
	let cwd = ""
	let activeAdapters = detectAdapters("")
	let missingAdapters = detectMissingAdapters("")
	let warned = false
	let ui: ExtensionUIContext | undefined

	createSystemPromptBlocks(pi, "dap").register({
		id: "dap-tools",
		render: () => (activeAdapters.length > 0 ? DAP_SYSTEM_PROMPT : undefined),
	})

	// ── Session start: detect adapters, set status footer, register tools ───────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd
		ui = ctx.ui
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

	// ── Degraded-state warning: notify once on the first agent turn ─────────────

	pi.on("before_agent_start", async () => {
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

	/** Detect the language of a program path when the file extension gives no
	 *  match (e.g. a Go package directory like `./cmd/server`). Checks for the
	 *  presence of language-specific source files in the directory. Returns the
	 *  matching adapter, or null if no language is detected. */
	function adapterForDirectory(dirPath: string, adapters: ReturnType<typeof allAdapters>) {
		try {
			const entries = readdirSync(dirPath)
			// Check for .go files → dlv
			if (entries.some((e) => e.endsWith(".go"))) {
				const goAdapter = adapters.find((a) => a.languages.includes("go"))
				if (goAdapter) return goAdapter
			}
			// Check for .py files → debugpy
			if (entries.some((e) => e.endsWith(".py"))) {
				const pyAdapter = adapters.find((a) => a.languages.includes("python"))
				if (pyAdapter) return pyAdapter
			}
			// Check for .ts/.js files → js-debug
			if (entries.some((e) => e.endsWith(".ts") || e.endsWith(".js"))) {
				const jsAdapter = adapters.find((a) => a.languages.includes("typescript") || a.languages.includes("javascript"))
				if (jsAdapter) return jsAdapter
			}
			// Check for .rs/.c/.cpp files → lldb-dap
			if (entries.some((e) => e.endsWith(".rs") || e.endsWith(".c") || e.endsWith(".cpp"))) {
				const nativeAdapter = adapters.find((a) => a.languages.includes("rust") || a.languages.includes("c"))
				if (nativeAdapter) return nativeAdapter
			}
		} catch {
			// Not a directory or unreadable — fall through to null
		}
		return null
	}

	/** Launch a debug session: resolve the adapter, connect the DapClient, create
	 *  the DapSession, and call session.launch(). Used by the debug_launch tool. */
	async function launchSession(opts: LaunchSessionOptions) {
		const program = resolvePath(opts.program)

		// Resolve adapter by explicit name, file extension, or directory contents.
		// allAdapters() returns the full static registry; getOrCreateClient
		// will surface a clear error if the binary isn't installed.
		const adapters = allAdapters()
		let adapter: (typeof adapters)[0] | null
		if (opts.adapterName) {
			adapter = adapters.find((a) => a.name === opts.adapterName) ?? null
		} else {
			// Try file extension first, then directory-based detection for
			// package directories (e.g. ./cmd/server for Go).
			adapter = adapterForFile(program, adapters)
			if (!adapter) adapter = adapterForDirectory(program, adapters)
		}

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
