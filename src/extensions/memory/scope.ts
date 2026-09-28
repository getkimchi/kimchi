/**
 * Project-scope resolution: which repository a session belongs to, for the
 * per-project memory store. Pure — unit-testable under Node.
 *
 * The scope id is `owner/name` from the repo's `origin` remote (stable
 * across clones and machines); the repo directory name is the fallback when
 * there is no remote. No repository (chat mode, the benchmark's containers)
 * → null → the personal store only.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export interface ProjectScope {
	/** `owner/name` (or the directory-name fallback) — for projectDbPath. */
	id: string
	/** The extraction prompt's project-context line. */
	contextLine: string
}

/** Path segments allowed in a project scope id (one segment per "/" level). */
export const PROJECT_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

/** Validate and return a sanitized scope id, or null when unusable. */
export function sanitizeScopeId(id: string): string | null {
	const segments = id.split("/")
	if (segments.length === 0 || segments.length > 4) return null
	if (segments.some((s) => !PROJECT_SEGMENT_RE.test(s) || s === "." || s === ".." || s.length === 0)) {
		return null
	}
	return segments.join("/")
}

function findGitRoot(start: string): string | null {
	let dir = start
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir
		const parent = dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

/** Parse owner[/group]/name out of a git remote URL (https and scp-like forms). */
export function parseOwnerName(url: string): string | null {
	const trimmed = url.trim().replace(/\.git$/, "")
	// scheme://host/owner/[group/]name — https, ssh://git@host, etc.
	const https = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/)
	// git@host:owner/[group/]name
	const scp = trimmed.match(/^git@[^:]+:(.+)$/)
	const path = https?.[1] ?? scp?.[1]
	if (!path) return null
	const segments = path.split("/")
	// At least owner/name; the full group path IS the identity for GitLab
	// subgroups (e.g. castai/kimchi/kimchi) — keep it complete.
	return segments.length >= 2 && segments.every((s) => s.length > 0) ? segments.join("/") : null
}

function gitRemoteOwnerName(root: string): string | null {
	// spawnSync with an argument array — no shell, no interpolation.
	const result = spawnSync("git", ["remote", "get-url", "origin"], {
		cwd: root,
		encoding: "utf-8",
		timeout: 5000,
	})
	if (result.status !== 0 || !result.stdout) return null
	return parseOwnerName(result.stdout.trim())
}

/**
 * Resolve the project scope for a working directory: the nearest `.git`
 * root's origin remote → `owner/name`; the repo directory name when there
 * is no remote; null when there is no repository (personal scope only).
 * Unparseable names degrade to null rather than guessing.
 */
export function resolveProjectScope(cwd: string): ProjectScope | null {
	const root = findGitRoot(cwd)
	if (!root) return null
	const id = sanitizeScopeId(gitRemoteOwnerName(root) ?? basename(root))
	if (!id) return null
	return { id, contextLine: `${id} (path: ${root})` }
}
