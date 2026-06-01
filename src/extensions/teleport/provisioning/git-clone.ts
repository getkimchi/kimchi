import type { spawn } from "node:child_process"
import { basename } from "node:path"
import { SANDBOX_HOME } from "./constants.js"
import { runSshCommandOnSandbox, shellEscapeValue } from "./ssh-exec.js"

/**
 * Derive a sandbox destination directory from a git remote URL.
 * Extracts the repository name from the URL path, stripping `.git` suffix.
 * Falls back to "workspace" if the name cannot be determined.
 */
export function deriveSandboxDestFromRepoUrl(repoUrl: string): string {
	// Try SSH shorthand: git@github.com:org/repo.git
	const sshMatch = repoUrl.match(/:([^/]+\/)?([^/]+?)(?:\.git)?$/)
	if (sshMatch?.[2]) return `${SANDBOX_HOME}/${sshMatch[2]}/`

	// Try URL-style
	try {
		const parsed = new URL(repoUrl)
		const segments = parsed.pathname.split("/").filter(Boolean)
		const last = segments.at(-1)
		if (last) {
			const name = last.replace(/\.git$/, "")
			if (name) return `${SANDBOX_HOME}/${name}/`
		}
	} catch {
		// not a valid URL
	}

	// Last resort: use basename heuristic
	const raw = basename(repoUrl.replace(/\.git$/, "").replace(/\/+$/, ""))
	return raw ? `${SANDBOX_HOME}/${raw}/` : `${SANDBOX_HOME}/workspace/`
}

export interface CloneRepoOnSandboxOptions {
	remoteHost: string
	remoteUser: string
	authToken: string
	/** Full git remote URL to clone (HTTPS or SSH). */
	repoUrl: string
	/** Destination directory on the sandbox. */
	destination: string
	/** Branch to check out after cloning. When omitted, the default branch is used. */
	branch?: string
	/** When true, perform a shallow clone (depth 1). Defaults to true. */
	shallow?: boolean
	signal?: AbortSignal
	/** Override for the proxy command (test seam). */
	proxyCommand?: string
	/** Test seam: injectable spawner. */
	_spawn?: typeof spawn
}

/**
 * Clone a git repository on the remote sandbox via SSH.
 *
 * Runs `git clone <url> <dest>` and optionally `git checkout <branch>`.
 * The clone uses `--single-branch` when a branch is specified for faster
 * cloning. Throws on non-zero SSH exit (caller handles gracefully).
 */
export async function cloneRepoOnSandbox(opts: CloneRepoOnSandboxOptions): Promise<void> {
	const shallow = opts.shallow ?? true
	const cloneArgs = ["git clone"]
	if (shallow) {
		cloneArgs.push("--depth", "1")
	}
	if (opts.branch) {
		cloneArgs.push("--branch", shellEscapeValue(opts.branch), "--single-branch")
	}
	cloneArgs.push(shellEscapeValue(opts.repoUrl), shellEscapeValue(opts.destination))

	await runSshCommandOnSandbox({
		remoteHost: opts.remoteHost,
		remoteUser: opts.remoteUser,
		authToken: opts.authToken,
		remoteCommand: cloneArgs.join(" "),
		signal: opts.signal,
		proxyCommand: opts.proxyCommand,
		_spawn: opts._spawn,
	})
}
