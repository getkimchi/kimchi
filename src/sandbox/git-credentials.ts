import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

/**
 * Extract the hostname from a git remote URL.
 *
 * Handles both HTTPS and SSH formats:
 *   - `https://github.com/org/repo.git` → `github.com`
 *   - `git@github.com:org/repo.git`     → `github.com`
 *   - `ssh://git@github.com/org/repo`   → `github.com`
 *   - `https://user@gitlab.com/a/b`     → `gitlab.com`
 */
export function parseHostFromRemoteUrl(url: string): string | undefined {
	const trimmed = url.trim()
	if (!trimmed) return undefined

	// SSH shorthand: git@github.com:org/repo.git
	const sshShorthand = trimmed.match(/^[\w.-]+@([\w.-]+):/)
	if (sshShorthand) return sshShorthand[1]

	// URL-style (https://, ssh://, git://)
	try {
		const parsed = new URL(trimmed)
		if (parsed.hostname) return parsed.hostname
	} catch {
		// not a valid URL — fall through
	}

	return undefined
}

export interface GetGitRemoteHostOptions {
	/** Override the exec function (for testing). */
	exec?: typeof execAsync
}

/**
 * Detect the git remote host for the repository at `cwd`.
 * Runs `git remote get-url origin` and parses the hostname.
 * Returns undefined if not a git repo or no origin remote.
 */
export async function getGitRemoteHost(cwd: string, options?: GetGitRemoteHostOptions): Promise<string | undefined> {
	const execImpl = options?.exec ?? execAsync
	try {
		const { stdout } = await execImpl(`git -C "${cwd}" remote get-url origin`)
		return parseHostFromRemoteUrl(stdout)
	} catch {
		return undefined
	}
}
