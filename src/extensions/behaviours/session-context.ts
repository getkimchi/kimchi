/**
 * SessionContext — immutable snapshot of session-time facts probed once at
 * session start. Subsequent reads by trigger predicates are pure lookups.
 *
 * Probes:
 * - `cli(name)` — true iff `name` is found on PATH (`which`).
 * - `gitRemote(host)` — true iff the host of `git remote get-url origin`
 *   matches.
 * - `path(glob)` — true iff at least one file under cwd matches the glob,
 *   walking up to `PATH_DEPTH_CAP` and skipping `PATH_IGNORED_DIRS`.
 *
 * The resolver collects the leaf probes declared by all behaviours and runs
 * each kind at most once. IO is injected so tests can stub `which` / git
 * without mocking subprocesses.
 */

import { execFileSync } from "node:child_process"
import type { Dirent } from "node:fs"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import micromatch from "micromatch"
import { isResourceEnabled } from "../../resources/store.js"
import { detectServers } from "../lsp/servers.js"
import { type ProbeSpec, walkLeaves } from "./triggers.js"

export interface SessionContext {
	readonly cliPresent: ReadonlySet<string>
	readonly gitRemoteHost: string | undefined
	readonly inGitRepo: boolean
	readonly pathMatches: ReadonlySet<string>
	/** File extensions served by the session-start LSP winner (empty when no
	 *  server won or LSP is resource-disabled). Snapshot at session start — a
	 *  mid-session lazy activation never revises it (per-session correctness
	 *  under ACP concurrency: a module-level live state would mis-gate
	 *  sibling sessions). */
	readonly lspServes: ReadonlySet<string>
}

export const PATH_DEPTH_CAP = 3
export const PATH_IGNORED_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".venv",
	"__pycache__",
	"target",
])

export interface ResolverProbes {
	cliCommands: ReadonlySet<string>
	needGitRemote: boolean
	needGitRepo: boolean
	pathGlobs: ReadonlySet<string>
	lspExtensions: ReadonlySet<string>
}

export function collectProbes(specs: Iterable<ProbeSpec>): ResolverProbes {
	const cliCommands = new Set<string>()
	const pathGlobs = new Set<string>()
	const lspExtensions = new Set<string>()
	let needGitRemote = false
	let needGitRepo = false
	for (const spec of specs) {
		walkLeaves(spec, (leaf) => {
			if (leaf.kind === "cli") cliCommands.add(leaf.name)
			else if (leaf.kind === "gitRemote") needGitRemote = true
			else if (leaf.kind === "gitRepo") needGitRepo = true
			else if (leaf.kind === "path") pathGlobs.add(leaf.glob)
			else if (leaf.kind === "lspServes") lspExtensions.add(leaf.ext)
		})
	}
	return { cliCommands, needGitRemote, needGitRepo, pathGlobs, lspExtensions }
}

export interface ResolverIO {
	hasCli(name: string): boolean
	readGitRemoteHost(cwd: string): string | undefined
	isGitRepo(cwd: string): boolean
	walkPaths(cwd: string, globs: ReadonlySet<string>): Set<string>
	/** Extensions served by the session-start LSP winner for `cwd`. */
	detectLspExtensions(cwd: string): ReadonlySet<string>
}

export const defaultResolverIO: ResolverIO = {
	hasCli(name: string): boolean {
		try {
			execFileSync("which", [name], { stdio: "ignore" })
			return true
		} catch {
			return false
		}
	},
	readGitRemoteHost(cwd: string): string | undefined {
		try {
			const url = execFileSync("git", ["remote", "get-url", "origin"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim()
			return parseRemoteHost(url)
		} catch {
			return undefined
		}
	},
	isGitRepo(cwd: string): boolean {
		// `.git` is a directory in a normal repo and a regular file in a linked
		// worktree or submodule — `existsSync` covers both without a subprocess.
		return existsSync(join(cwd, ".git"))
	},
	walkPaths(cwd, globs) {
		return walkAndMatch(cwd, globs, PATH_DEPTH_CAP)
	},
	/** The same gate `cli.ts` applies via `enabledExtensionFactories` — when
	 *  the LSP resource is disabled (local override or org FORCE_OFF) no LSP
	 *  extension, tools, or prompt block exist, so markers and the binary
	 *  must not suppress Python validation guidance. `detectServers` shares
	 *  the session-start snapshot semantics (single winner, KIMCHI_LSP_BINARIES
	 *  override included) — a leaf module with fs/child_process only, no
	 *  cycles. */
	detectLspExtensions(cwd: string): ReadonlySet<string> {
		if (!isResourceEnabled("extensions.lsp")) return new Set()
		return new Set(detectServers(cwd)[0]?.extensions ?? [])
	},
}

/** Extract the hostname from an ssh-form (`git@host:owner/repo`) or http(s) git remote URL. */
export function parseRemoteHost(url: string): string | undefined {
	if (!url) return undefined
	const ssh = /^[^@\s]+@([^:]+):/.exec(url)
	if (ssh) return ssh[1]
	try {
		return new URL(url).host || undefined
	} catch {
		return undefined
	}
}

/**
 * Walk `cwd` up to `depthCap` levels deep, returning the subset of `globs`
 * that match at least one file. Stops as soon as every glob has matched.
 */
export function walkAndMatch(cwd: string, globs: ReadonlySet<string>, depthCap: number): Set<string> {
	const matched = new Set<string>()
	if (globs.size === 0) return matched
	const remaining = new Set(globs)

	function visit(absDir: string, relDir: string, depth: number): void {
		if (depth > depthCap) return
		if (remaining.size === 0) return
		let entries: Dirent[]
		try {
			entries = readdirSync(absDir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (remaining.size === 0) return
			const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`
			if (entry.isDirectory()) {
				if (PATH_IGNORED_DIRS.has(entry.name)) continue
				visit(join(absDir, entry.name), relPath, depth + 1)
				continue
			}
			if (!entry.isFile()) continue
			for (const glob of remaining) {
				if (micromatch.isMatch(relPath, glob, { dot: true })) {
					matched.add(glob)
					remaining.delete(glob)
					if (remaining.size === 0) return
				}
			}
		}
	}

	visit(cwd, "", 1)
	return matched
}

export function resolveSessionContext(
	specs: Iterable<ProbeSpec>,
	cwd: string,
	io: ResolverIO = defaultResolverIO,
): SessionContext {
	const { cliCommands, needGitRemote, needGitRepo, pathGlobs, lspExtensions } = collectProbes(specs)
	const cliPresent = new Set<string>()
	for (const name of cliCommands) {
		if (io.hasCli(name)) cliPresent.add(name)
	}
	const gitRemoteHost = needGitRemote ? io.readGitRemoteHost(cwd) : undefined
	const inGitRepo = needGitRepo ? io.isGitRepo(cwd) : false
	const pathMatches = io.walkPaths(cwd, pathGlobs)
	const lspServes = lspExtensions.size > 0 ? io.detectLspExtensions(cwd) : new Set<string>()
	return { cliPresent, gitRemoteHost, inGitRepo, pathMatches, lspServes }
}
