// extensions/dap.ts
/**
 * DAP (Debug Adapter Protocol) Extension
 *
 * Gives the agent runtime debugger access via DAP. Supports TypeScript/JavaScript
 * (js-debug), Python (debugpy), Go (dlv dap), and native (lldb-dap).
 *
 * Modeled on extensions/lsp.ts: detects adapters on session_start, sets a status
 * footer, registers the Layer 1 primitive tools and the Layer 2 composed
 * tools (debug_state_at, debug_trace_calls, ...), injects a DAP system prompt
 * plus on-demand language skills, and tears down on session_shutdown.
 *
 * Usage: kimchi -e extensions/dap.ts
 */
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { ExtensionAPI, ExtensionUIContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import {
	adapterExists,
	adapterForDirectory,
	adapterForFile,
	allAdapters,
	detectAdapters,
	detectMissingAdapters,
} from "./dap/adapters.js"
import { DapClientRegistry } from "./dap/client.js"
import { DapSessionRegistry } from "./dap/session.js"
import { createLayer1Tools, createLayer2Tools, type LaunchSessionOptions } from "./dap/tools.js"
import { createSystemPromptBlocks } from "./prompt-construction/index.js"

const DAP_SYSTEM_PROMPT = `## Debugger (DAP)

DAP tools give you a live debugger — your first tool for understanding runtime behavior. **Do NOT trace variable values through code by hand.** A breakpoint + \`debug_eval\` shows you the actual value in ~500 tokens; reasoning through code takes ~50,000 tokens and can still be wrong. The debugger is both faster and cheaper.

**Quick start — one call answers most questions:**
- "What is the value of X at line N?" → \`debug_state_at({file, line, evaluated: ["X"]})\`
- "Why does this throw and what is the state when it does?" → \`debug_last_error({program})\`
- "Which functions actually run and in what order?" → \`debug_trace_calls({program})\`
- "How does this value change as the program steps?" → \`debug_watch_change({file, line, expression})\`

For interactive stepping: \`debug_launch\` → \`debug_set_breakpoint\` → \`debug_continue\` → \`debug_locals\` / \`debug_eval\` → \`debug_terminate\`.

The adapter is auto-detected from the file extension (.go→dlv, .py→debugpy, .ts/.js→js-debug, .rs/.c→lldb-dap). For Go package directories, the adapter is detected from \`.go\` files.`

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

const DAP_TS_SKILL = `### TypeScript/JavaScript Debugging with js-debug

**What you can debug:**
- JavaScript files (.js/.mjs/.cjs) run directly: \`debug_state_at({file: "app.js", line: N})\`
- TypeScript files (.ts) need a runtime that executes them — plain Node fails on type syntax. Options: compile first (\`tsc\`/esbuild) and debug the .js output (source maps link breakpoints back to .ts), or install tsx and launch with \`node_modules/.bin/tsx\` as the program, or Node 22.8+ with --experimental-strip-types. Breakpoints set in .ts source work when source maps exist (default).
- Node.js programs: \`debug_launch({program: "app.js"})\`
- js-debug uses a nested session architecture (startDebugging reverse-request). The client automatically handles this — you don't need to do anything special.

**Where to set breakpoints — think about WHERE the bug manifests:**
- At the decision point: the \`if\`/\`switch\`/\`for\` where wrong behavior starts
- At the entry of the function that returns the wrong value
- At the mutation point: where a data structure is modified (\`push\`, \`splice\`, \`set\`, \`delete\`)
- At error handling: \`catch\` blocks where the error path diverges
- At async boundaries: \`await\` points where promises resolve with unexpected values

**Debugging methodology — how to be a good debugger:**
1. **Reproduce first**: Run the program (\`bash: node app.ts\` or \`bash: npx tsx app.ts\`) to see the actual wrong output. Note which line produces it.
2. **Set a breakpoint near the symptom**: Use \`debug_state_at\` at the line where wrong output appears.
3. **Work backward**: If the variable is wrong, where was it set? Set a breakpoint at the mutation point.
4. **Compare expected vs actual**: At each breakpoint, ask "what should this value be?" and compare.
5. **Inspect data structures, not just primitives**: For arrays/objects, use \`debug_locals\` — the bug is often in a nested property.

**Expression syntax for debug_eval and debug_state_at evaluated parameter:**

js-debug (V8 debugger) supports full JavaScript eval — any valid JS expression works:
- Property access: \`obj.property\`, \`arr[0]\`, \`arr.length\`
- Method calls: \`arr.map(x => x * 2)\`, \`obj.toString()\`, \`JSON.stringify(obj)\`
- Template literals: \`\`value: \${variable}\`\`
- Destructuring: \`const { a, b } = obj\` (in eval context, use \`obj.a\` instead)
- Built-in functions: \`Array.isArray(x)\`, \`typeof x\`, \`Object.keys(obj)\`, \`Object.entries(obj)\`
- Async: \`await promise\` (if at an await point)

**Inspecting common JS/TS data structures:**
- Arrays: \`arr.length\`, \`arr[0]\`, \`arr.slice(0, 10)\`
- Objects: \`Object.keys(obj)\`, \`Object.entries(obj)\`, \`JSON.stringify(obj, null, 2)\`
- Maps: \`map.size\`, \`Array.from(map.entries())\`
- Sets: \`set.size\`, \`Array.from(set)\`
- Classes: \`obj.constructor.name\`, \`Object.getPrototypeOf(obj)\`
- Errors: \`err.message\`, \`err.stack\`, \`err.code\`

**Gotchas:**
- js-debug requires the program to be launched via the adapter (not run separately). The adapter handles starting the Node.js process.
- Source maps: if debugging TypeScript, js-debug reads source maps automatically. Ensure \`sourceMaps: true\` in the launch config (it's set by default).
- Async debugging: breakpoints inside \`async\` functions work correctly. The adapter handles \`await\` points.

**Productive patterns:**
- One-shot inspection: \`debug_state_at({file, line, evaluated: ["arr.length", "JSON.stringify(obj)", "Object.keys(map)"]})\`
- Use \`debug_eval\` freely — JS/TS has no expression limitations unlike Go
- Use \`debug_last_error({program})\` to capture uncaught exceptions with locals at the throw site
- Interactive stepping: \`debug_launch\` → \`debug_set_breakpoint\` → \`debug_continue\` → \`debug_locals\` → \`step_over\` → \`debug_locals\` (repeat)`

const DAP_JAVA_SKILL = `### Java Debugging with java-debug

**What you can debug:**
- Any Java program with a main method: \`debug_state_at({file: "Main.java", line: N})\`
- Kotlin programs (.kt/.kts): same adapter, same workflow
- Requires Java Debug Server (com.microsoft.java.debug.plugin)

**Expression syntax:**
- Field access: \`this.field\`, \`obj.field\`
- Method calls: \`obj.toString()\`, \`list.size()\`, \`map.get("key")\`
- Built-in: \`Math.max(a, b)\`, \`String.valueOf(obj)\`, \`Arrays.toString(arr)\`

**Inspecting data structures:**
- Lists: \`list.size()\`, \`list.get(0)\`
- Maps: \`map.keySet()\`, \`map.get("key")\`, \`map.size()\`
- Arrays: \`arr.length\`, \`Arrays.toString(arr)\`
- Objects: \`obj.toString()\`, \`obj.getClass().getName()\`

**Productive patterns:**
- One-shot: \`debug_state_at({file, line, evaluated: ["list.size()", "map.get(\\"key\\")"]})\`
- Use \`debug_eval\` freely — Java supports method calls in eval`

const DAP_RUBY_SKILL = `### Ruby Debugging with rdbg

**What you can debug:**
- Any Ruby script: \`debug_state_at({file: "app.rb", line: N})\`
- Rails apps: set breakpoints in controllers/models
- rdbg ships with Ruby 3.1+ (no install needed)

**Expression syntax:**
- Full Ruby eval: \`obj.method\`, \`arr.length\`, \`hash["key"]\`
- Method calls: \`obj.to_s\`, \`arr.map { |x| x * 2 }\`, \`hash.keys\`
- Built-in: \`obj.class\`, \`obj.instance_variables\`, \`obj.methods\`

**Inspecting data structures:**
- Arrays: \`arr.length\`, \`arr[0]\`, \`arr.first\`, \`arr.last\`
- Hashes: \`hash.keys\`, \`hash.values\`, \`hash["key"]\`
- Objects: \`obj.instance_variables\`, \`obj.class\`, \`obj.to_s\`

**Productive patterns:**
- One-shot: \`debug_state_at({file, line, evaluated: ["arr.length", "hash.keys", "obj.class"]})\`
- Use \`debug_eval\` freely — Ruby has no expression limitations`

const DAP_PHP_SKILL = `### PHP Debugging with php-debug-adapter

**What you can debug:**
- Any PHP script: \`debug_state_at({file: "index.php", line: N})\`
- Laravel/Symfony apps: set breakpoints in controllers
- Requires Xdebug extension + php-debug-adapter

**Expression syntax:**
- Full PHP eval: \`$obj->method()\`, \`count($arr)\`, \`$arr[0]\`
- Method calls: \`$obj->getProperty()\`, \`array_map(fn($x) => $x * 2, $arr)\`
- Built-in: \`get_class($obj)\`, \`array_keys($arr)\`, \`count($arr)\`

**Inspecting data structures:**
- Arrays: \`count($arr)\`, \`$arr[0]\`, \`array_keys($arr)\`
- Objects: \`get_class($obj)\`, \`$obj->getProperty()\`, \`get_object_vars($obj)\`
- Exceptions: \`$e->getMessage()\`, \`$e->getTraceAsString()\`

**Productive patterns:**
- One-shot: \`debug_state_at({file, line, evaluated: ["count($arr)", "get_class($obj)"]})\`
- Use \`debug_eval\` freely — PHP supports method calls in eval`

export default function (pi: ExtensionAPI) {
	// The dap-debugging skill is now a bundled skill (resources/skills/dap-debugging/)
	// surfaced via the unified resources_discover mechanism; no deploy step needed.

	let cwd = ""
	let activeAdapters = detectAdapters("")
	let missingAdapters = detectMissingAdapters("")
	let warned = false
	let ui: ExtensionUIContext | undefined

	// Per-extension-instance registries. Held in closure scope (not module-level)
	// so two activations of this extension in the same process do not share
	// debug client or session state. Mirrors the LSP extension's scoping but
	// instance-scoped rather than module-scoped.
	const clientRegistry = new DapClientRegistry()
	const sessionRegistry = new DapSessionRegistry()

	// On-demand skill injection: language skills are NOT injected until the
	// agent calls a debug tool for the first time. This saves ~1K tokens per
	// API call when the agent is not debugging.
	let goSkillActive = false
	let pythonSkillActive = false
	let tsSkillActive = false
	let javaSkillActive = false
	let rubySkillActive = false
	let phpSkillActive = false

	const dapBlocks = createSystemPromptBlocks(pi, "dap")
	dapBlocks.register({
		id: "dap-tools",
		render: () => (activeAdapters.length > 0 ? DAP_SYSTEM_PROMPT : undefined),
	})

	// Language-specific skills — only render when the matching adapter is detected.
	// These provide concrete expression syntax, data structure inspection patterns,
	// and adapter-specific gotchas that the general DAP_SYSTEM_PROMPT doesn't cover.
	dapBlocks.register({
		id: "dap-go-skill",
		render: () => (goSkillActive ? DAP_GO_SKILL : undefined),
	})
	dapBlocks.register({
		id: "dap-python-skill",
		render: () => (pythonSkillActive ? DAP_PYTHON_SKILL : undefined),
	})
	dapBlocks.register({
		id: "dap-ts-skill",
		render: () => (tsSkillActive ? DAP_TS_SKILL : undefined),
	})
	dapBlocks.register({
		id: "dap-java-skill",
		render: () => (javaSkillActive ? DAP_JAVA_SKILL : undefined),
	})
	dapBlocks.register({
		id: "dap-ruby-skill",
		render: () => (rubySkillActive ? DAP_RUBY_SKILL : undefined),
	})
	dapBlocks.register({
		id: "dap-php-skill",
		render: () => (phpSkillActive ? DAP_PHP_SKILL : undefined),
	})

	// ── Session start: detect adapters, set status footer, register tools ───────

	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd
		ui = ctx.ui
		warned = false
		goSkillActive = false
		pythonSkillActive = false
		tsSkillActive = false
		javaSkillActive = false
		rubySkillActive = false
		phpSkillActive = false
		activeAdapters = detectAdapters(cwd)
		missingAdapters = detectMissingAdapters(cwd)

		updateStatusFooter()

		// Register Layer 1 tools (idempotent — registerTool replaces by name).
		// Deps are wired here so tools.ts stays free of extension wiring.
		const deps = {
			cwd,
			getSession: (id: string) => sessionRegistry.get(id),
			removeSession: (id: string) => sessionRegistry.remove(id),
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
		// Await both: today these are sync, but awaiting makes the handler safe
		// against them becoming async later (a fire-and-forget promise here would
		// race process exit or the next session start).
		await sessionRegistry.clearAll()
		await clientRegistry.shutdownAll()
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

	// ── On-demand skill injection: activate language skills on first debug tool call ─
	pi.on("tool_call", (event) => {
		const name = (event as ToolCallEvent).toolName
		if (name.startsWith("debug_") || name.startsWith("step_")) {
			if (activeAdapters.some((a) => a.name === "dlv")) goSkillActive = true
			if (activeAdapters.some((a) => a.name === "debugpy")) pythonSkillActive = true
			if (activeAdapters.some((a) => a.name === "js-debug")) tsSkillActive = true
			if (activeAdapters.some((a) => a.name === "java-debug")) javaSkillActive = true
			if (activeAdapters.some((a) => a.name === "rdbg")) rubySkillActive = true
			if (activeAdapters.some((a) => a.name === "php-debug-adapter")) phpSkillActive = true
		}
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

		// Resolve adapter by explicit name, file extension, or directory contents.
		// allAdapters() returns the full static registry; getOrCreateClient
		// will surface a clear error if the binary isn't installed.
		const adapters = allAdapters()
		let adapter: (typeof adapters)[0] | null
		if (opts.adapterName) {
			adapter = adapters.find((a) => a.name === opts.adapterName) ?? null
		} else {
			// Try file extension first, then directory-based detection: the program
			// may itself be a package directory (./cmd/server for Go) or an
			// extensionless compiled binary — in the latter case inspect the source
			// files alongside it (main next to main.c).
			adapter = adapterForFile(program, adapters)
			if (!adapter) adapter = adapterForDirectory(program, adapters)
			if (!adapter) {
				const parent = path.dirname(program)
				if (parent !== program) adapter = adapterForDirectory(parent, adapters)
			}
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

		// Re-verify availability before spawning: the resolved adapter's binary may
		// not be installed (probe happened at session_start, or the model picked
		// an explicit adapter name). Fail with an actionable error instead of
		// spawning a missing binary.
		if (!adapterExists(adapter)) {
			throw new Error(
				`DAP adapter "${adapter.name}" is not installed or not on PATH.${adapter.installHint ? ` Install with: ${adapter.installHint}` : ""}`,
			)
		}

		// Pre-generate the session id so the client is keyed per session: every
		// launch spawns its own adapter process (a DAP connection is one-debuggee),
		// so debug_terminate can never cross-kill another session's client.
		const sessionId = randomUUID()
		const client = await clientRegistry.getOrCreate(adapter, cwd, sessionId)
		const session = sessionRegistry.create({ adapter, cwd, client, id: sessionId })
		try {
			await session.launch({
				program,
				cwd,
				args: opts.args,
				stopOnEntry: opts.stopOnEntry,
				env: opts.env,
			})
		} catch (err) {
			// Launch failed before the caller received a session id, so
			// debug_terminate can never reach this session — clean up directly or
			// the adapter process leaks until session_shutdown. terminate() kills
			// the client proc, and the proc-exit hook in client.ts then reaps the
			// client from DapClientRegistry.
			sessionRegistry.remove(sessionId)
			await session.terminate()
			throw err
		}
		return session
	}
}
