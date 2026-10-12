// extensions/lsp/servers.ts
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { ServerConfig } from "./types.js"

const TS_EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]

// The classic TypeScript server gets used from several detection branches —
// reference it by identity instead of repeating the name string (and without
// a non-null `as` on a SERVERS.find()).
const TYPESCRIPT_LANGUAGE_SERVER: ServerConfig = {
	name: "typescript-language-server",
	command: "typescript-language-server",
	args: ["--stdio"],
	extensions: TS_EXTENSIONS,
	installHint: "npm i -g typescript-language-server typescript",
}

const SERVERS: ServerConfig[] = [
	TYPESCRIPT_LANGUAGE_SERVER,
	{
		name: "gopls",
		command: "gopls",
		args: [],
		extensions: ["go"],
		installHint: "go install golang.org/x/tools/gopls@latest",
	},
	{
		name: "pyright",
		command: "pyright-langserver",
		args: ["--stdio"],
		extensions: ["py", "pyw"],
		// pyright never emits $/progress startup cycles — waiting would stall
		// on the fixed timeout at every startup (same reason as the TS7 native
		// server). It's ready to serve as soon as the initialize reply lands.
		skipProjectLoadWait: true,
		installHint: "npm i -g pyright",
	},
]

/**
 * Test-only override: when KIMCHI_LSP_BINARIES is set, `exists()` ignores the
 * real PATH and returns true only for commands listed in the comma-separated
 * value. This lets E2E TUI tests control which LSP servers appear "installed"
 * regardless of the host machine's setup. When unset, normal `which` behavior.
 */
const LSP_BINARIES_OVERRIDE = process.env.KIMCHI_LSP_BINARIES

function exists(cmd: string): boolean {
	if (LSP_BINARIES_OVERRIDE !== undefined) {
		const available = LSP_BINARIES_OVERRIDE.split(",").map((s) => s.trim())
		return available.includes(cmd)
	}
	// Try Bun first (dev mode), fall back to Node child_process (production build)
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

/**
 * Returns the LSP servers relevant to the current project. At most ONE
 * server is active per session: an LSP server is a long-lived subprocess, so
 * activating one per language of a polyglot repo wastes a process per session
 * for languages the session rarely touches. Candidates are collected via
 * marker presence (upward walk first, bounded downward scan for nested-module
 * monorepos as fallback), then narrowed: root/ancestor markers beat
 * nested-scan matches, remaining ties go to the language with the most source
 * files within depth 2, and registry order breaks exact ties. Servers are
 * activated when their binary is on PATH — e.g. a Go project won't activate
 * typescript-language-server even if it's on PATH.
 */
export function detectServers(cwd: string): ServerConfig[] {
	const winner = selectWinner(cwd)
	if (!winner) return []
	// TypeScript resolves to one of two flavors (classic vs TS7 native) —
	// the workspace's own compiler decides.
	if (winner.server === TYPESCRIPT_LANGUAGE_SERVER) return detectTsServers(cwd)
	return exists(winner.server.command) ? [winner.server] : []
}

/** Marker-match candidate for session-start activation. */
interface MarkerCandidate {
	server: ServerConfig
	/** True when the marker was found by the upward walk (cwd or an ancestor). */
	fromRoot: boolean
}

/** All servers whose project marker is present for cwd, with match direction. */
function markerCandidates(cwd: string): MarkerCandidate[] {
	const out: MarkerCandidate[] = []
	for (const s of SERVERS) {
		const markers = ROOT_MARKERS[s.name] ?? []
		if (findMarkerUp(cwd, markers)) out.push({ server: s, fromRoot: true })
		else if (findMarkerDown(cwd, markers, 2)) out.push({ server: s, fromRoot: false })
	}
	return out
}

/**
 * The single activation winner for cwd, ignoring binary availability —
 * shared by detectServers (activate it) and detectMissingCandidates (report
 * it as missing). Returns undefined when no markers match at all.
 */
function selectWinner(cwd: string): MarkerCandidate | undefined {
	const candidates = markerCandidates(cwd)
	if (candidates.length === 0) return undefined
	// A marker in cwd or an ancestor is a much stronger signal than one found
	// by scanning subdirectories — drop nested-only candidates whenever a
	// root-level one exists.
	const pool = candidates.some((c) => c.fromRoot) ? candidates.filter((c) => c.fromRoot) : candidates
	if (pool.length === 1) return pool[0]
	// Polyglot tie (e.g. package.json + pyproject.toml at the root, or several
	// languages detected only via nested modules): the dominant language by
	// source-file count wins — that is the language the session is most likely
	// to actually edit.
	let best = pool[0]
	let bestCount = -1
	for (const candidate of pool) {
		const count = countSourceFiles(cwd, candidate.server.extensions)
		if (count > bestCount) {
			best = candidate
			bestCount = count
		}
	}
	return best
}

/**
 * Count source files matching `extensions` within two subdir levels of cwd
 * (the same reach as the nested-module marker scan), skipping dot-dirs and
 * vendored trees. Cheap enough for session-start selection, coarse enough to
 * rank languages.
 */
function countSourceFiles(cwd: string, extensions: string[], depth: number = 3): number {
	if (depth <= 0) return 0
	const dir = path.resolve(cwd)
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return 0
	}
	let count = 0
	for (const entry of entries) {
		if (entry.name.startsWith(".") || (entry.isDirectory() && SKIP_DIRS.has(entry.name))) continue
		if (entry.isDirectory()) {
			count += countSourceFiles(path.join(dir, entry.name), extensions, depth - 1)
		} else if (extensions.includes(path.extname(entry.name).slice(1).toLowerCase())) {
			count++
		}
	}
	return count
}

/**
 * Pick the TypeScript server for cwd. A TypeScript 7 workspace gets its own
 * native server even when typescript-language-server is installed — the
 * workspace's compiler is the right language-service semantics, and no
 * global install is needed. Otherwise the classic server is kept whenever
 * its binary is on PATH; when tsserver is unresolvable the failure then
 * lands on the clean failed-to-start path rather than going silent.
 */
function detectTsServers(cwd: string): ServerConfig[] {
	if (!markerPresent(cwd, ROOT_MARKERS["typescript-language-server"])) return []
	const nativePath = resolveTsNativeServerPath(cwd)
	if (nativePath) return [tsNativeConfig(nativePath)]
	return exists(TYPESCRIPT_LANGUAGE_SERVER.command) ? [TYPESCRIPT_LANGUAGE_SERVER] : []
}

/**
 * Returns the LSP server whose project marker is present in cwd or any
 * parent directory (with the nested-module downward fallback) but whose
 * binary is NOT on PATH — i.e. the server this project would use if
 * installed, at most one per session (mirrors detectServers' single-winner
 * selection). Used to surface a degraded LSP state to the user instead of
 * silently no-op'ing.
 */
export function detectMissingCandidates(cwd: string): ServerConfig[] {
	const winner = selectWinner(cwd)
	if (!winner) return []
	if (winner.server === TYPESCRIPT_LANGUAGE_SERVER) {
		// TypeScript is only "missing" when neither the classic server nor
		// the TypeScript 7 native fallback could be activated.
		return detectTsServers(cwd).length === 0 ? [winner.server] : []
	}
	return exists(winner.server.command) ? [] : [winner.server]
}

/** Get the server config for a specific file path, or null if no server applies. */
export function serverForFile(filePath: string, servers: ServerConfig[]): ServerConfig | null {
	const ext = path.extname(filePath).slice(1).toLowerCase()
	return servers.find((s) => s.extensions.includes(ext)) ?? null
}

/**
 * If cwd is a git worktree, return the main repository root.
 * Returns undefined if cwd is not a worktree (no .git, .git is a directory,
 * or the gitdir line doesn't point at a worktrees entry).
 */
export function findMainRepoRoot(cwd: string): string | undefined {
	const dotGitPath = path.join(cwd, ".git")
	if (!fs.existsSync(dotGitPath)) return undefined

	// If .git is a directory, this is a normal repo root, not a worktree.
	const stat = fs.statSync(dotGitPath)
	if (stat.isDirectory()) return undefined

	const content = fs.readFileSync(dotGitPath, "utf-8").trim()
	const gitdirMatch = content.match(/^gitdir:\s*(.+)$/m)
	if (!gitdirMatch) return undefined

	const gitdir = gitdirMatch[1]
	// gitdir looks like /path/to/main-repo/.git/worktrees/<name>
	const worktreeMatch = gitdir.match(/^(.+?\/\.git)\/worktrees\/[^/]+$/)
	if (!worktreeMatch) return undefined

	const mainRoot = path.dirname(worktreeMatch[1])
	return path.isAbsolute(mainRoot) ? mainRoot : path.resolve(cwd, mainRoot)
}

/**
 * Resolve the tsserver.js path for the given cwd.
 * Checks cwd's node_modules first, then the main repo root if cwd is a
 * git worktree. Returns undefined if nothing is found.
 */
export function resolveTsserverPath(cwd: string): string | undefined {
	const localTsserver = path.join(cwd, "node_modules/typescript/lib/tsserver.js")
	if (fs.existsSync(localTsserver)) return localTsserver

	const mainRepo = findMainRepoRoot(cwd)
	if (mainRepo) {
		const mainTsserver = path.join(mainRepo, "node_modules/typescript/lib/tsserver.js")
		if (fs.existsSync(mainTsserver)) return mainTsserver
	}

	return undefined
}

/**
 * Signature of the TypeScript 7 native package: it ships `bin/tsc` (the
 * launcher for the native compiler) but no `lib/tsserver.js` — the language
 * service lives inside the native binary and is exposed as a plain LSP
 * server via `tsc --lsp --stdio`.
 */
function tsNativeBinAt(dir: string): string | undefined {
	const bin = path.join(dir, "node_modules/typescript/bin/tsc")
	const tsserver = path.join(dir, "node_modules/typescript/lib/tsserver.js")
	return fs.existsSync(bin) && !fs.existsSync(tsserver) ? bin : undefined
}

/**
 * Resolve the TypeScript 7 native server's tsc launcher for the given cwd.
 * The workspace's own typescript package decides the flavor: when cwd's own
 * package is classic (tsserver.js present) the native server is NOT used,
 * even if the main repo is native — the workspace's compiler semantics win.
 * Only when cwd has no resolvable typescript package at all does the
 * main-repo fallback (git worktrees) apply.
 */
export function resolveTsNativeServerPath(cwd: string): string | undefined {
	const ownNative = tsNativeBinAt(cwd)
	if (ownNative) return ownNative
	if (fs.existsSync(path.join(cwd, "node_modules/typescript/lib/tsserver.js"))) return undefined
	const mainRepo = findMainRepoRoot(cwd)
	if (mainRepo) return tsNativeBinAt(mainRepo)
	return undefined
}

/** Build the ServerConfig for a TypeScript 7 native server at tscPath. */
function tsNativeConfig(tscPath: string): ServerConfig {
	return {
		name: "typescript-native",
		command: tscPath,
		args: ["--lsp", "--stdio"],
		extensions: TS_EXTENSIONS,
		// The native server emits no $/progress startup cycles (so progress
		// waiting would stall on the fixed timeout), and it has no push
		// diagnostics — diagnostics are pulled via textDocument/diagnostic.
		skipProjectLoadWait: true,
		pullDiagnostics: true,
	}
}

const ROOT_MARKERS: Record<string, string[]> = {
	gopls: ["go.mod"],
	"typescript-language-server": ["tsconfig.json", "package.json"],
	"typescript-native": ["tsconfig.json", "package.json"],
	pyright: ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile"],
}

/** Directories the bounded downward marker scan never descends into —
 *  vendored/build trees that routinely contain third-party module markers
 *  (e.g. .devbox/go/pkg/mod with dozens of go.mod files). Dot-directories
 *  are skipped separately. */
const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", "out", "target"])

/**
 * Bounded downward marker scan for nested-module monorepos — repos whose
 * go.mod/package.json live only in subdirectories (e.g. apis/grpc, cli/cai).
 * Depth ≤ 2 from cwd, skipping dot-dirs and SKIP_DIRS. Called only as a
 * fallback when the upward walk (findMarkerUp) finds nothing, so flat repos
 * and repos with root markers keep their existing detection semantics.
 */
function findMarkerDown(cwd: string, markers: string[], depth: number): boolean {
	if (depth <= 0) return false
	const dir = path.resolve(cwd)
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true })
	} catch {
		return false
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue
		const child = path.join(dir, entry.name)
		if (markers.some((m) => fs.existsSync(path.join(child, m)))) return true
		if (findMarkerDown(child, markers, depth - 1)) return true
	}
	return false
}

/**
 * Marker present for the session cwd: primary upward walk from cwd, plus a
 * bounded downward fallback for nested-module monorepos. Exported so the
 * DAP adapter registry (dap/adapters.ts) shares the exact same semantics.
 */
export function markerPresent(cwd: string, markers: string[]): boolean {
	return findMarkerUp(cwd, markers) || findMarkerDown(cwd, markers, 2)
}

/**
 * Walk up from `cwd` to the filesystem root, returning true if any of the
 * given marker files is found in cwd or a parent directory.
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

/**
 * Walk up from filePath to find the nearest project root for the given server.
 * Clamps to sessionCwd — never escapes above it.
 * Falls back to path.dirname(filePath) if no marker found.
 */
export function findRoot(filePath: string, serverName: string, sessionCwd: string): string {
	const markers = ROOT_MARKERS[serverName] ?? []
	let dir = path.dirname(filePath)
	const boundary = sessionCwd

	while (true) {
		if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return dir
		if (dir === boundary || dir === path.dirname(dir)) break
		dir = path.dirname(dir)
	}

	// If no marker found within sessionCwd, use file's own directory
	return path.dirname(filePath)
}
