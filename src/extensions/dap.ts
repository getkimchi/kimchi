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

DAP tools give you a live debugger — your first tool for understanding runtime behavior, not a last resort. **Do NOT trace variable values through code by hand.** If you need to know what a variable's value is at runtime, set a breakpoint and look at it. A breakpoint + \`debug_eval\` shows you the actual value in seconds and ~500 tokens; reasoning through code takes minutes, ~50,000 tokens, and can still be wrong. The debugger is both faster and cheaper.

**Use the debugger instead of:**
- Tracing variable values through code by hand ("if generation is 1 here, then after the loop it becomes...") → **STOP.** Use \`debug_state_at({file, line, evaluated: ["var"]})\` to see the actual value. Do not spend thinking tokens on tracing runtime values — the debugger answers in one call.
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

const DAP_GO_SKILL = `### Go Debugging with dlv

**What you can debug:**
- Any Go program with a \`main\` package: \`debug_state_at({file: "main.go", line: N})\`
- Go package directories: \`debug_launch({program: "./cmd/server", adapter: "dlv"})\`
- Programs with build flags: build with \`go build -gcflags="all=-N -l"\` to disable inlining/optimization for better debugging
- Tests: set a breakpoint in test code and use \`debug_state_at\` — the debugger will build and run the test binary

**Where to set breakpoints — think about WHERE the bug manifests:**
- At the decision point: the \`if\`/\`switch\`/\`for\` where wrong behavior starts
- At the entry of the function that returns the wrong value
- At the line that produces wrong output (e.g. the \`fmt.Println\` or \`return\` statement)
- At the mutation point: where a data structure is modified (\`Push\`, \`Write\`, \`Set\`, \`Delete\`)
- At error handling: \`if err != nil\` blocks where the error path diverges
- At loop boundaries: the first and last iteration where behavior changes

**Debugging methodology — how to be a good debugger:**
1. **Reproduce first**: Run the program (\`bash: go run main.go\`) to see the actual wrong output. Note which line produces it.
2. **Set a breakpoint near the symptom**: Use \`debug_state_at\` at the line where wrong output appears. Inspect locals and evaluate the key variables.
3. **Work backward**: If the variable is wrong at the breakpoint, where was it set? Set a breakpoint at the mutation point and inspect the state before and after.
4. **Compare expected vs actual**: At each breakpoint, ask "what should this value be?" and compare. The difference IS the bug.
5. **Check loop invariants**: For loops, set a breakpoint inside the loop and use \`debug_eval\` with \`len()\` or index variables to verify the invariant holds each iteration.
6. **Inspect data structures, not just primitives**: For slices/maps/structs, use \`debug_locals\` (which shows nested fields) — the bug is often in a field you didn't think to check.

**Expression syntax for debug_eval and debug_state_at evaluated parameter:**

Works:
- Field access: \`cache.capacity\`, \`node.children\`, \`buf.head\`
- Map access: \`cache.items["key"]\`, \`m[64:]\` (slice operator for paginating)
- Slice/array indexing: \`slice[0]\`, \`slice[10:20]\`
- Built-in functions: \`len(slice)\`, \`cap(slice)\`
- Pointer dereference: \`*ptr\`
- Type assertion on interfaces: \`iface.(*main.ConcreteType)\`
- Package-qualified variables: \`"some/pkg".VarName\`

Does NOT work (common failure — do NOT attempt):
- Method calls on unexported fields: \`cache.lru.Len()\` → fails
- Method calls in general: \`obj.Method()\` → fails (unless using experimental \`call\` prefix)
- Instead of \`cache.lru.Len()\`, use \`len(cache.items)\` or inspect \`cache.lru\` via debug_locals

**Inspecting common Go data structures:**
- Slices: \`len(s)\` for length, \`s[0]\` for first element, \`s[64:]\` for elements past 64
- Maps: \`m["key"]\` for a specific key, \`m[64:]\` for paginated key-value pairs
- Structs: use \`debug_locals\` (shows nested fields one level deep) instead of \`debug_eval\`
- Interfaces: \`iface.(*main.ConcreteType)\` to extract the concrete value
- Pointers: \`*ptr\` to dereference
- Goroutines: \`runtime.curg.goid\` for current goroutine ID

**Gotchas:**
- Arrays/slices/maps limited to 64 elements in eval output — use \`slice[64:]\` to see more
- Nested struct inspection limited to 2 levels deep — use field access to go deeper
- Maps iterate in a fixed order (not sorted)
- Unexported fields (lowercase names like \`lru\`, \`items\`) are accessible via field access but method calls on them fail
- Go may inline small functions — if a breakpoint doesn't hit, the code may be inlined. Build with \`-gcflags="all=-N -l"\` to disable inlining.

**Productive patterns:**
- One-shot inspection: \`debug_state_at({file, line, evaluated: ["len(slice)", "m[\\"key\\"]", "*ptr"]})\`
- Interactive stepping: \`debug_launch\` → \`debug_set_breakpoint\` → \`debug_continue\` → \`debug_locals\` → \`step_over\` → \`debug_locals\` (repeat)
- Watch a value change: \`debug_watch_change({file, line, expression: "count"})\`
- Trace execution flow: \`debug_trace_calls({program})\`
- If an expression fails, simplify: try just the variable name, then inspect its fields via debug_locals`

const DAP_PYTHON_SKILL = `### Python Debugging with debugpy

**What you can debug:**
- Any Python script: \`debug_state_at({file: "app.py", line: N})\`
- Python modules: \`debug_launch({program: "app.py"})\` or a specific .py file
- Programs with virtual environments: the debugger uses the system Python by default; ensure your venv is active or the script is runnable directly
- Tests: set a breakpoint in test code and use \`debug_state_at\`

**Where to set breakpoints — think about WHERE the bug manifests:**
- At the decision point: the \`if\`/\`for\`/\`while\` where wrong behavior starts
- At the entry of the function that returns the wrong value
- At the line that produces wrong output (e.g. the \`print()\` or \`return\` statement)
- At the mutation point: where a data structure is modified (\`append\`, \`dict[key] = val\`, \`self.attr = x\`)
- At exception handling: \`except\` blocks where the error path diverges
- At loop boundaries: the first and last iteration where behavior changes
- Before a suspected crash: set a breakpoint just before the line that raises

**Debugging methodology — how to be a good debugger:**
1. **Reproduce first**: Run the program (\`bash: python app.py\`) to see the actual wrong output or exception. Note which line produces it.
2. **Set a breakpoint near the symptom**: Use \`debug_state_at\` at the line where wrong output appears. Inspect locals and evaluate the key variables.
3. **Work backward**: If the variable is wrong at the breakpoint, where was it set? Set a breakpoint at the mutation point and inspect the state before and after.
4. **Compare expected vs actual**: At each breakpoint, ask "what should this value be?" and compare. The difference IS the bug.
5. **Check loop invariants**: For loops, set a breakpoint inside the loop and use \`debug_eval\` to verify the invariant holds each iteration.
6. **Inspect data structures, not just primitives**: For dicts/lists/objects, use \`debug_locals\` (which shows nested fields) — the bug is often in an attribute you didn't think to check.

**Expression syntax for debug_eval and debug_state_at evaluated parameter:**

Python debugpy supports full Python eval — any valid Python expression works:
- Method calls: \`obj.method()\`, \`dict.keys()\`, \`list.append(x)\`
- Comprehensions: \`[x for x in items if x > 0]\`
- Built-in functions: \`len(x)\`, \`type(obj)\`, \`isinstance(x, Y)\`, \`dir(obj)\`
- Dict inspection: \`d.items()\`, \`d.keys()\`, \`d.values()\`
- Object introspection: \`obj.__dict__\`, \`vars(obj)\`, \`dir(obj)\`
- String formatting: \`f"{var} = {value}"\`

**Inspecting common Python data structures:**
- Dicts: \`d["key"]\`, \`d.get("key", default)\`, \`d.items()\`
- Lists: \`lst[0]\`, \`lst[-1]\`, \`lst[0:10]\`, \`len(lst)\`
- Objects: \`obj.__dict__\` for all attributes, \`type(obj).__name__\` for class name
- Exceptions: \`str(e)\`, \`repr(e)\`, \`e.args\`

**Gotchas:**
- Multi-line expressions may not persist intermediate variables reliably
- Modifying globals requires \`globals()['key'] = value\` syntax
- Evaluation happens in the current frame's scope — use \`debug_backtrace\` to select the right frame

**Productive patterns:**
- One-shot inspection: \`debug_state_at({file, line, evaluated: ["len(data)", "type(obj)", "obj.__dict__"]})\`
- Use \`debug_eval\` freely — Python has no expression limitations unlike Go
- Use \`debug_last_error({program})\` to capture exceptions with locals at the throw site
- Interactive stepping: \`debug_launch\` → \`debug_set_breakpoint\` → \`debug_continue\` → \`debug_locals\` → \`step_over\` → \`debug_locals\` (repeat)`

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

	// Language-specific skills — only render when the matching adapter is detected.
	// These provide concrete expression syntax, data structure inspection patterns,
	// and adapter-specific gotchas that the general DAP_SYSTEM_PROMPT doesn't cover.
	createSystemPromptBlocks(pi, "dap").register({
		id: "dap-go-skill",
		render: () => (activeAdapters.some((a) => a.name === "dlv") ? DAP_GO_SKILL : undefined),
	})
	createSystemPromptBlocks(pi, "dap").register({
		id: "dap-python-skill",
		render: () => (activeAdapters.some((a) => a.name === "debugpy") ? DAP_PYTHON_SKILL : undefined),
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
