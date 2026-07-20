// extensions/dap/adapters.ts
//
// =============================================================================
// js-debug protocol conclusion (spike, 2026-07-20)
// =============================================================================
// Q: Does `node --inspect-brk` speak DAP directly, or Chrome DevTools Protocol
//    (CDP)?
// A: CDP. Node's --inspect* flags start the V8 inspector, which exposes a
//    WebSocket endpoint on 127.0.0.1:9229 speaking CDP — NOT DAP. Confirmed by
//    the Node.js inspector docs: "Node.js inspector supports all the Chrome
//    DevTools Protocol domains declared by V8." There is no DAP framing on
//    that socket.
//
//    Therefore `node --inspect-brk` alone CANNOT be driven by the DAP client
//    in client.ts. TypeScript is a must-have v1 acceptance target, so we use
//    @vscode/js-debug (microsoft/vscode-js-debug) — a DAP-native JavaScript
//    debugger that internally translates DAP <-> CDP. It is the default JS
//    debugger in VS Code and ships a standalone pure-DAP server tarball
//    (`js-debug-dap-<ver>.tar.gz`) on its GitHub releases page, also packaged
//    as the `js-debug-adapter` npm/Mason package for editors like Neovim.
//
// Architectural impact (resolved below):
//   js-debug's standalone DAP server entry point is `dapDebugServer.js`, and
//   it is TCP-based, NOT stdio. Invocation is:
//       node <js-debug>/src/dapDebugServer.js <port> [host]
//   The DAP client then CONNECTS to 127.0.0.1:<port> over TCP. This differs
//   from dlv dap / debugpy / lldb-dap, which all speak DAP over stdio and fit
//   the existing `command + args` BunProcess.spawn model in client.ts.
//
//   DapAdapterConfig now carries a `transport` discriminator (see types.ts):
//     - { kind: "stdio" }                              // dlv, debugpy, lldb-dap
//     - { kind: "tcp"; portArgIndex: number }          // js-debug
//   client.ts's getOrCreateClient will branch on it at the session layer
//   (Phase 3): for "tcp" adapters, spawn the server with port=0, parse the
//   bound port from stdout, then open a TCP socket and run the same framing
//   pump over the socket. The framing/correlation/event-pump logic in
//   client.ts is transport-agnostic (only needs a duplex byte stream), so the
//   change is isolated to spawn+connect plumbing.
//
//   js-debug's `command` is `node` (always on PATH), so detection via `which
//   node` is meaningless. The `detectBinary` field points `which` at the
//   `js-debug-adapter` shim instead — the npm/Mason package name that exists
//   iff js-debug is actually installed.
//
// Sources:
//   - https://nodejs.org/docs/v22.11.0/api/inspector.html  (CDP, not DAP)
//   - https://github.com/microsoft/vscode-js-debug          (DAP-based JS debugger)
//   - https://github.com/microsoft/vscode-js-debug/releases (js-debug-dap tarball)
//   - nvim-dap wiki: Debug Adapter installation             (dapDebugServer.js <port>)
// =============================================================================

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { DapAdapterConfig } from "./types.js"

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
		// Session layer assembles the final argv at launch:
		//   node <dapDebugServer.js path> <port> 127.0.0.1
		// `args` is empty here because the script path is resolved from the
		// js-debug-adapter install location at launch time (not statically
		// knowable). `transport.portArgIndex` points at the port in the
		// session-assembled argv.
		args: [],
		detectBinary: "js-debug-adapter",
		transport: { kind: "tcp", portArgIndex: 1, host: "127.0.0.1" },
		languages: ["typescript", "javascript"],
		extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
		launchType: "pwa-node",
		installHint:
			"npm i -g js-debug-adapter  (or download js-debug-dap-<ver>.tar.gz from github.com/microsoft/vscode-js-debug/releases)",
		launchConfig: { sourceMaps: true },
	},
	{
		name: "debugpy",
		command: "debugpy",
		args: ["--listen", "stdio"],
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
		transport: { kind: "tcp", portArgIndex: -1 }, // -1 = no port arg; dlv picks ephemeral
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
		languages: ["rust", "c", "cpp"],
		extensions: ["rs", "c", "h", "cc", "cpp", "cxx", "hpp"],
		launchType: "lldb",
		installHint: "Install via your LLVM/Clang distribution or `cargo install lldb-dap`",
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
	"lldb-dap": ["Cargo.toml", "CMakeLists.txt", "Makefile"],
}

/**
 * Test-only override: when KIMCHI_DAP_BINARIES is set, `exists()` ignores the
 * real PATH and returns true only for detectBinary names listed in the
 * comma-separated value. This lets tests control which adapters appear
 * "installed" regardless of the host machine's setup. When unset, normal
 * `which` behavior. Mirrors KIMCHI_LSP_BINARIES exactly.
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
		return findMarkerUp(cwd, markers) && exists(detectBinaryOf(a))
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
		return hasMarker && !exists(detectBinaryOf(a))
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
