// extensions/lsp/servers.ts
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { ServerConfig } from "./types.js"

const SERVERS: ServerConfig[] = [
	{
		name: "typescript-language-server",
		command: "typescript-language-server",
		args: ["--stdio"],
		extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
		installHint: "npm i -g typescript-language-server typescript",
	},
	{
		name: "gopls",
		command: "gopls",
		args: [],
		extensions: ["go"],
		installHint: "go install golang.org/x/tools/gopls@latest",
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
 * Returns LSP servers whose binary is available on PATH AND whose project
 * marker (go.mod, tsconfig.json, package.json) exists in cwd or a parent
 * directory. This ensures only servers relevant to the current project are
 * activated — e.g. a Go project won't activate typescript-language-server
 * even if it's on PATH.
 */
export function detectServers(cwd: string): ServerConfig[] {
	return SERVERS.filter((s) => {
		const markers = ROOT_MARKERS[s.name] ?? []
		return findMarkerUp(cwd, markers) && exists(s.command)
	})
}

/**
 * Returns LSP servers whose project marker (go.mod, tsconfig.json, package.json)
 * is present in cwd or any parent directory up to the filesystem root, but
 * whose binary is NOT on PATH — i.e. servers this project would use if
 * installed. Used to surface a degraded LSP state to the user instead of
 * silently no-op'ing. Walks parent directories so monorepo subdirectories
 * where the marker lives in a parent are detected.
 */
export function detectMissingCandidates(cwd: string): ServerConfig[] {
	return SERVERS.filter((s) => {
		const markers = ROOT_MARKERS[s.name] ?? []
		const hasMarker = findMarkerUp(cwd, markers)
		return hasMarker && !exists(s.command)
	})
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

const ROOT_MARKERS: Record<string, string[]> = {
	gopls: ["go.mod"],
	"typescript-language-server": ["tsconfig.json", "package.json"],
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
