// extensions/dap/adapters.ts
//
// Adapter registry for DAP debug adapters. Mirrors lsp/servers.ts.
// Supports stdio (debugpy, lldb-dap, java-debug, rdbg, php-debug-adapter)
// and TCP transports (dlv dap, js-debug). js-debug uses nested sessions via
// the startDebugging reverse-request — see client.ts for handling.
// See docs/extensions/dap.md for architecture details.

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { DapAdapterConfig } from "./types.js"

/** Resolve the js-debug dapDebugServer.js script path. Searches common install
 *  locations: $JS_DEBUG_PATH, node_modules paths, and the standard global
 *  npm prefix. Returns null if not found. Exported so client.ts can reuse
 *  the same resolution at spawn time. */
export function resolveJsDebugScript(): string | null {
	if (process.env.JS_DEBUG_PATH && fs.existsSync(process.env.JS_DEBUG_PATH)) return process.env.JS_DEBUG_PATH
	const candidates = [
		"node_modules/js-debug-adapter/src/dapDebugServer.js",
		"node_modules/@vscode/js-debug/src/dapDebugServer.js",
	]
	for (const c of candidates) {
		if (fs.existsSync(c)) return c
	}
	// npm global prefix
	try {
		const result = spawnSync("npm", ["prefix", "-g"], { encoding: "utf-8" })
		if (result.status === 0) {
			const prefix = result.stdout.trim()
			const globalPath = `${prefix}/lib/node_modules/js-debug-adapter/src/dapDebugServer.js`
			if (fs.existsSync(globalPath)) return globalPath
		}
	} catch {
		// npm not available
	}
	return null
}

/**
 * Registry of supported debug adapters. Mirrors lsp/servers.ts's SERVERS array.
 *
 * `command`/`args` are the subprocess invocation (what client.ts spawns).
 * `detectBinary` is what `which` checks for availability — defaults to
 * `command` for stdio adapters, but overridden for js-debug (invoked as
 * `node <script>` so we detect the `js-debug-adapter` shim instead of `node`).
 *
 * `transport` tells client.ts how to talk to the adapter: stdio (dlv/debugpy/
 * lldb-dap) or tcp (js-debug's dapDebugServer.js, which takes a port arg).
 *
 * `extensions`/`languages` drive adapterForFile/adapterForLanguage resolution.
 */
const ADAPTERS: DapAdapterConfig[] = [
	{
		name: "js-debug",
		command: "node",
		// The DAP server is dapDebugServer.js from the vscode-js-debug
		// GitHub releases tarball (js-debug-dap-<ver>.tar.gz). There is no
		// npm package or standalone binary — extract the tarball and set
		// JS_DEBUG_PATH to the extracted dapDebugServer.js path, or let
		// client.ts search common install locations.
		args: [],
		detect: () => resolveJsDebugScript() !== null,
		transport: { kind: "tcp", host: "127.0.0.1" },
		languages: ["typescript", "javascript"],
		extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
		launchType: "pwa-node",
		installHint:
			"Download js-debug-dap-<ver>.tar.gz from github.com/microsoft/vscode-js-debug/releases, extract, and set JS_DEBUG_PATH to the extracted js-debug/src/dapDebugServer.js",
		launchConfig: { sourceMaps: true },
	},
	{
		name: "debugpy",
		command: "python3",
		args: ["-m", "debugpy.adapter"],
		detectModule: ["python3", "-c", "import debugpy"],
		transport: { kind: "stdio" },
		languages: ["python"],
		extensions: ["py", "pyw"],
		launchType: "python",
		installHint: "pip install debugpy",
	},
	{
		name: "dlv",
		command: "dlv",
		args: ["dap"],
		// dlv dap is TCP-based: it starts a headless TCP server and prints
		// "DAP server listening at: <host>:<port>" to stdout. The DAP client
		// connects via TCP. (Despite the name, dlv dap does NOT speak stdio.)
		transport: { kind: "tcp" }, // dlv picks an ephemeral port
		languages: ["go"],
		extensions: ["go"],
		launchType: "go",
		// dlv dap requires mode: "debug" to build & launch the program.
		launchConfig: { mode: "debug" },
		installHint: "go install github.com/go-delve/delve/cmd/dlv@latest",
	},
	{
		name: "lldb-dap",
		command: "lldb-dap",
		args: [],
		transport: { kind: "stdio" },
		// Swift reuses lldb-dap (LLDB is Apple's Swift debugger). No separate
		// adapter needed — just add the language/extension + Package.swift marker.
		languages: ["rust", "c", "cpp", "swift"],
		extensions: ["rs", "c", "h", "cc", "cpp", "cxx", "hpp", "swift"],
		launchType: "lldb",
		installHint: "Install via your LLVM/Clang distribution or `cargo install lldb-dap`",
	},
	{
		name: "java-debug",
		command: "java-debug",
		args: [],
		transport: { kind: "stdio" },
		// Kotlin compiles to JVM bytecode and debugs via the same Java Debug
		// Server, so .kt/.kts reuse this adapter (no separate Kotlin adapter).
		languages: ["java", "kotlin"],
		extensions: ["java", "kt", "kts"],
		launchType: "java",
		installHint:
			"Install the Java Debug Server (com.microsoft.java.debug.plugin) — see github.com/microsoft/vscode-java-debug, or `:DapInstall java-debug` via Mason",
	},
	{
		name: "rdbg",
		command: "rdbg",
		args: [],
		transport: { kind: "stdio" },
		languages: ["ruby"],
		extensions: ["rb"],
		launchType: "ruby",
		installHint: "rdbg ships with Ruby 3.1+ or: gem install debug",
	},
	{
		name: "php-debug-adapter",
		command: "php-debug-adapter",
		args: [],
		transport: { kind: "stdio" },
		languages: ["php"],
		extensions: ["php"],
		launchType: "php",
		installHint: "npm install -g php-debug-adapter",
	},
]

/**
 * Project-root markers per adapter. A marker present in cwd or any parent
 * directory signals "this project would use this adapter if installed" —
 * used by detectAdapters (marker + binary) and detectMissingAdapters
 * (marker + no binary → degraded state). Mirrors lsp/servers.ts ROOT_MARKERS.
 */
const ROOT_MARKERS: Record<string, string[]> = {
	"js-debug": ["package.json", "tsconfig.json"],
	debugpy: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
	dlv: ["go.mod"],
	"lldb-dap": ["Cargo.toml", "CMakeLists.txt", "Makefile", "Package.swift"],
	"java-debug": ["pom.xml", "build.gradle", "build.gradle.kts"],
	rdbg: ["Gemfile", "Rakefile"],
	"php-debug-adapter": ["composer.json"],
}

/**
 * Test-only override: when KIMCHI_DAP_BINARIES is set, `exists()` ignores the
 * real PATH and returns true only for names listed in the comma-separated
 * value. The listed names are adapter names throughout: for binary adapters
 * the adapter name matches its binary (dlv, lldb-dap, ...), for js-debug the
 * name applies to its custom script-path detection, and for module-based
 * adapters (debugpy) the name applies to the `detectModule` check.
 * This lets tests control which adapters appear "installed" regardless of the
 * host machine's setup. When unset, normal detection behavior. Mirrors
 * KIMCHI_LSP_BINARIES exactly.
 */
const DAP_BINARIES_OVERRIDE = process.env.KIMCHI_DAP_BINARIES

/**
 * Check whether a binary is available on PATH (or whitelisted by
 * KIMCHI_DAP_BINARIES). Uses Bun.spawnSync when available (dev), falls back to
 * node:child_process spawnSync (production build). Argument-array form only —
 * never execSync with interpolation. Mirrors lsp/servers.ts exists().
 */
function exists(cmd: string): boolean {
	if (DAP_BINARIES_OVERRIDE !== undefined) {
		const available = DAP_BINARIES_OVERRIDE.split(",").map((s) => s.trim())
		return available.includes(cmd)
	}
	try {
		// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
		const Bun = (globalThis as any).Bun
		if (Bun?.spawnSync) {
			const result = Bun.spawnSync(["which", cmd], { stdout: "pipe", stderr: "pipe" })
			return result.exitCode === 0
		}
	} catch {
		// ignore, try Node fallback
	}
	try {
		const result = spawnSync("which", [cmd], { stdio: "pipe" })
		return result.status === 0
	} catch {
		return false
	}
}

/** Check if a command+args exits 0 (for module-presence checks like
 *  `python3 -c "import debugpy"`). Uses Bun.spawnSync when available, falls
 *  back to node:child_process spawnSync. */
function existsCmd(argv: string[]): boolean {
	if (DAP_BINARIES_OVERRIDE !== undefined) {
		// For module-based adapters, check if the module name is in the override
		const available = DAP_BINARIES_OVERRIDE.split(",").map((s) => s.trim())
		return available.includes(argv[0])
	}
	try {
		// biome-ignore lint/suspicious/noExplicitAny: Bun not typed without @types/bun
		const Bun = (globalThis as any).Bun
		if (Bun?.spawnSync) {
			const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" })
			return result.exitCode === 0
		}
	} catch {
		// ignore, try Node fallback
	}
	try {
		const result = spawnSync(argv[0], argv.slice(1), { stdio: "pipe" })
		return result.status === 0
	} catch {
		return false
	}
}

/** Check if an adapter's runtime is available. Uses `detect` (custom function)
 *  when set, then `detectModule` (e.g. `python3 -c "import debugpy"`),
 *  otherwise `detectBinary` or `command` (via `which`).
 *  Exported so launch paths can re-verify availability before spawning. */
export function adapterExists(adapter: DapAdapterConfig): boolean {
	if (DAP_BINARIES_OVERRIDE !== undefined) {
		// Test override: whitelist tokens are adapter NAMES throughout.
		// js-debug matches its custom script-path detection, and module-based
		// adapters (debugpy) match by name — not by the executor argv[0] of
		// their detectModule check ("python3"), which would whitelist the
		// interpreter, not the adapter.
		if (adapter.detect) {
			const available = DAP_BINARIES_OVERRIDE.split(",").map((s) => s.trim())
			return available.includes(adapter.name)
		}
		if (adapter.detectModule) {
			const available = DAP_BINARIES_OVERRIDE.split(",").map((s) => s.trim())
			return available.includes(adapter.name)
		}
		const available = DAP_BINARIES_OVERRIDE.split(",").map((s) => s.trim())
		return available.includes(detectBinaryOf(adapter))
	}
	if (adapter.detect) {
		return adapter.detect()
	}
	if (adapter.detectModule) {
		return existsCmd(adapter.detectModule)
	}
	return exists(detectBinaryOf(adapter))
}

/** The binary name `which` should check for this adapter — `detectBinary` if
 *  set, else `command`. This is the "run_cmd prefix heuristic": for adapters
 *  invoked as `node <script>` or `python -m <module>`, we detect the
 *  shim/module (js-debug-adapter, debugpy) rather than the generic interpreter. */
function detectBinaryOf(adapter: DapAdapterConfig): string {
	return adapter.detectBinary ?? adapter.command
}

/**
 * Returns debug adapters whose binary is available on PATH AND whose project
 * marker (go.mod, package.json, pyproject.toml, Cargo.toml, ...) exists in cwd
 * or a parent directory. Only adapters relevant to the current project are
 * activated — e.g. a Go project won't activate js-debug even if it's installed.
 * Mirrors lsp/servers.ts detectServers.
 */
export function detectAdapters(cwd: string): DapAdapterConfig[] {
	return ADAPTERS.filter((a) => {
		const markers = ROOT_MARKERS[a.name] ?? []
		return findMarkerUp(cwd, markers) && adapterExists(a)
	})
}

/**
 * Returns debug adapters whose project marker is present in cwd or any parent
 * directory, but whose binary is NOT on PATH — i.e. adapters this project
 * would use if installed. Used to surface a degraded DAP state (status footer
 * shows "DAP: <name> not installed") instead of silently no-op'ing. Mirrors
 * lsp/servers.ts detectMissingCandidates.
 */
export function detectMissingAdapters(cwd: string): DapAdapterConfig[] {
	return ADAPTERS.filter((a) => {
		const markers = ROOT_MARKERS[a.name] ?? []
		const hasMarker = findMarkerUp(cwd, markers)
		return hasMarker && !adapterExists(a)
	})
}

/**
 * Resolve an adapter for a file path from the given (already-detected)
 * adapters, by extension. Returns null if none applies. Mirrors
 * lsp/servers.ts serverForFile. Extension match is dotless (e.g. "ts").
 */
export function adapterForFile(filePath: string, adapters: DapAdapterConfig[]): DapAdapterConfig | null {
	const ext = path.extname(filePath).slice(1).toLowerCase()
	return adapters.find((a) => a.extensions.includes(ext)) ?? null
}

/**
 * Resolve an adapter for a language id (e.g. "typescript", "go") from the
 * given adapters. Returns null if none applies. Used by the session layer
 * when a language is known but no file path is (e.g. attach by language).
 */
export function adapterForLanguage(language: string, adapters: DapAdapterConfig[]): DapAdapterConfig | null {
	const lang = language.toLowerCase()
	return adapters.find((a) => a.languages.some((l) => l.toLowerCase() === lang)) ?? null
}

/** The full registry. Exported for tests and the status-footer lookup. */
export function allAdapters(): DapAdapterConfig[] {
	return ADAPTERS
}

/** Detect the language of a directory when the program path's extension gives
 *  no match — e.g. a Go package directory (`./cmd/server`) or the directory
 *  containing an extensionless compiled binary (main next to main.c). Checks
 *  for language-specific source files in the directory. Returns the matching
 *  adapter, or null if no language is detected. */
export function adapterForDirectory(dirPath: string, adapters: DapAdapterConfig[]): DapAdapterConfig | null {
	try {
		const entries = fs.readdirSync(dirPath)
		const extsPresent = new Set(entries.map((e) => path.extname(e).slice(1).toLowerCase()).filter((ext) => ext !== ""))
		// Match against each adapter's OWN `extensions` list — so every suffix
		// declared in ADAPTERS counts (.tsx, .jsx, .swift, .cc, .cxx, .java,
		// .rb, .php, ...). Keep the original language-priority order for
		// mixed-language directories: go, python, js/ts, native, then whatever
		// else the registry offers (java, ruby, php) in registry order.
		const priorityLangs = ["go", "python", "typescript", "javascript", "rust", "c", "cpp", "swift"]
		for (const lang of priorityLangs) {
			const adapter = adapters.find(
				(a) => a.languages.includes(lang) && a.extensions.some((ext) => extsPresent.has(ext.toLowerCase())),
			)
			if (adapter) return adapter
		}
		return adapters.find((a) => a.extensions.some((ext) => extsPresent.has(ext.toLowerCase()))) ?? null
	} catch {
		// Not a directory or unreadable — fall through to null
	}
	return null
}

/**
 * Walk up from `cwd` to the filesystem root, returning true if any of the
 * given marker files is found in cwd or a parent directory. Mirrors
 * lsp/servers.ts findMarkerUp.
 */
function findMarkerUp(cwd: string, markers: string[]): boolean {
	let dir = path.resolve(cwd)
	while (true) {
		if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return true
		const parent = path.dirname(dir)
		if (dir === parent) break
		dir = parent
	}
	return false
}
