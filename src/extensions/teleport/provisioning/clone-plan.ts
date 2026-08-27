import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type ClonePlanErrorCode = "not-a-git-repo" | "no-origin" | "url-mismatch" | "not-https"

export class ClonePlanError extends Error {
	readonly code: ClonePlanErrorCode

	constructor(code: ClonePlanErrorCode, message: string) {
		super(message)
		this.name = "ClonePlanError"
		this.code = code
	}
}

export interface ClonePlan {
	url: string
	httpsUrl: string
	branch?: string
}

/**
 * Parse the `git@host:path` SSH shorthand into host + path. Shared by
 * toHttpsRepoUrl and canonicalRepoUrl to avoid duplicating the regex.
 */
function parseSshShorthand(url: string): { host: string; path: string } | undefined {
	const m = url.match(/^[\w.-]+@([\w.-]+):(.+)$/)
	return m ? { host: m[1], path: m[2] } : undefined
}

/** Strip userinfo for safe display in error messages. */
function redactUrl(url: string): string {
	try {
		const p = new URL(url)
		return p.username || p.password ? `${p.protocol}//${p.host}${p.pathname}${p.search}${p.hash}` : url
	} catch {
		return url
	}
}

/** Convert a clone URL to HTTPS form; undefined if not convertible. */
export function toHttpsRepoUrl(url: string): string | undefined {
	const trimmed = url.trim()
	if (!trimmed) return undefined
	const ssh = parseSshShorthand(trimmed)
	if (ssh) return `https://${ssh.host}/${ssh.path}`
	try {
		const p = new URL(trimmed)
		if (p.protocol === "https:") return trimmed
		if (p.protocol === "ssh:") return `https://${p.host}${p.pathname}`
	} catch {
		// not a URL
	}
	return undefined
}

/** Canonical `host/path` for equality comparison (ignores scheme/user/.git/case). */
export function canonicalRepoUrl(url: string): string | undefined {
	const https = toHttpsRepoUrl(url.trim())
	if (!https) return undefined
	const p = new URL(https)
	const path = p.pathname
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.replace(/^\/+/, "")
	if (!path) return undefined
	return `${p.hostname}/${path}`
}

type GitExecFn = (
	args: readonly string[],
	opts?: { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string }>

/**
 * Resolve the clone plan for `/teleport --fast`. Explicit `--git-repo` URL
 * wins over cwd's origin. Throws ClonePlanError for: not-a-git-repo,
 * no-origin, url-mismatch, not-https. Uses execFile (argv) — no shell injection.
 */
export async function resolveClonePlan(
	cwd: string,
	explicitUrl: string | undefined,
	opts?: { exec?: GitExecFn; signal?: AbortSignal },
): Promise<ClonePlan> {
	const gitExec: GitExecFn =
		opts?.exec ?? ((args, o) => execFileAsync("git", ["-C", cwd, ...args], { ...o, encoding: "utf8" }))

	const isRepo = await gitExec(["rev-parse", "--is-inside-work-tree"])
		.then(({ stdout }) => stdout.trim() === "true")
		.catch(() => false)
	if (!isRepo) throw new ClonePlanError("not-a-git-repo", `${cwd} is not a git repository`)

	const originUrl = await gitExec(["remote", "get-url", "origin"])
		.then(({ stdout }) => stdout.trim() || undefined)
		.catch(() => undefined)

	const url = explicitUrl ?? originUrl
	if (url === undefined)
		throw new ClonePlanError("no-origin", "--fast requires --git-repo URL or a git repo with an origin remote")

	if (explicitUrl !== undefined && originUrl !== undefined) {
		if (canonicalRepoUrl(originUrl) !== canonicalRepoUrl(explicitUrl)) {
			throw new ClonePlanError(
				"url-mismatch",
				`cwd origin ${redactUrl(originUrl)} does not match --git-repo URL ${redactUrl(explicitUrl)}`,
			)
		}
	}

	const httpsUrl = toHttpsRepoUrl(url)
	if (!httpsUrl || !canonicalRepoUrl(url))
		throw new ClonePlanError("not-https", `${redactUrl(url)} is not a valid HTTP(S) clone URL`)

	const branch = await gitExec(["symbolic-ref", "--short", "HEAD"])
		.then(({ stdout }) => stdout.trim() || undefined)
		.catch(() => undefined)

	// Verify the branch exists on origin before passing it to the sandbox.
	// The sandbox worker clones from origin — if the branch is local-only
	// (unpushed), `git clone --branch <name>` fails and the fallback creates
	// the branch at whatever HEAD the sandbox was left on, which may be a
	// different branch entirely. Returning undefined makes the sandbox use
	// the default branch, which is safer than silently checking out the wrong
	// code.
	let safeBranch = branch
	if (branch) {
		const onRemote = await gitExec(["ls-remote", "--heads", "origin", branch])
			.then(({ stdout }) => stdout.trim().length > 0)
			.catch(() => true) // on error, trust the branch (network issues, etc.)
		if (!onRemote) safeBranch = undefined
	}

	return { url, httpsUrl, branch: safeBranch }
}
