import { exec, type spawn } from "node:child_process"
import { promisify } from "node:util"
import { runSshCommandOnSandbox, shellEscapeValue } from "./ssh-exec.js"

const execAsync = promisify(exec)

/**
 * Read the local git user.name and user.email from the repository at `cwd`.
 * Returns undefined for each value that is not configured.
 */
export async function readLocalGitConfig(cwd: string): Promise<{ name?: string; email?: string }> {
	let name: string | undefined
	let email: string | undefined
	try {
		const { stdout } = await execAsync(`git -C "${cwd}" config user.name`)
		const trimmed = stdout.trim()
		if (trimmed) name = trimmed
	} catch {}
	try {
		const { stdout } = await execAsync(`git -C "${cwd}" config user.email`)
		const trimmed = stdout.trim()
		if (trimmed) email = trimmed
	} catch {}
	return { name, email }
}

export interface PropagateGitConfigOptions {
	remoteHost: string
	remoteUser: string
	authToken: string
	gitName?: string
	gitEmail?: string
	signal?: AbortSignal
	/** Override for the proxy command (test seam). */
	proxyCommand?: string
	/** Test seam: injectable spawner. */
	_spawn?: typeof spawn
}

/**
 * Set git config --global user.name and user.email on the remote sandbox
 * via SSH. Issues one SSH call per value because the sandbox uses
 * ForceCommand=git — the remote command is passed as git argv, so shell
 * operators like `&&` are not interpreted.
 * Skips silently if both values are undefined.
 * Throws on non-zero exit from ssh (caller handles gracefully).
 */
export async function propagateGitConfigToSandbox(opts: PropagateGitConfigOptions): Promise<void> {
	if (!opts.gitName && !opts.gitEmail) return

	if (opts.gitName) {
		await runSshCommandOnSandbox({
			remoteHost: opts.remoteHost,
			remoteUser: opts.remoteUser,
			authToken: opts.authToken,
			remoteCommand: `git config --global user.name ${shellEscapeValue(opts.gitName)}`,
			signal: opts.signal,
			proxyCommand: opts.proxyCommand,
			_spawn: opts._spawn,
		})
	}
	if (opts.gitEmail) {
		await runSshCommandOnSandbox({
			remoteHost: opts.remoteHost,
			remoteUser: opts.remoteUser,
			authToken: opts.authToken,
			remoteCommand: `git config --global user.email ${shellEscapeValue(opts.gitEmail)}`,
			signal: opts.signal,
			proxyCommand: opts.proxyCommand,
			_spawn: opts._spawn,
		})
	}
}

export interface PropagateGitCredentialOptions {
	remoteHost: string
	remoteUser: string
	authToken: string
	/** The git host to configure credentials for (e.g. "github.com"). */
	gitHost: string
	/** The personal access token to store as the git credential. */
	gitToken: string
	/** Username for the credential entry. Defaults to "oauth2". */
	gitUsername?: string
	signal?: AbortSignal
	/** Override for the proxy command (test seam). */
	proxyCommand?: string
	/** Test seam: injectable spawner. */
	_spawn?: typeof spawn
}

/**
 * Configure git credentials on the remote sandbox via SSH so it can
 * push/pull without a prompt. Three SSH calls:
 *   1. `git config --global credential.helper 'cache --timeout=86400'`
 *   2. `git credential approve` with the credential block piped via stdin
 *   3. `git config --global url.https://host/.insteadOf git@host:` to
 *      rewrite SSH remotes to HTTPS (so the stored credential is used)
 *
 * Uses the git credential cache daemon (in-memory, 24h TTL) instead of
 * the `store` helper so tokens are never persisted to disk on the sandbox.
 * This function is safe to call on every attach/connect — the cache daemon
 * is idempotent and successive `credential approve` calls simply refresh
 * the cached entry.
 *
 * Throws on non-zero SSH exit (caller handles gracefully).
 */
export async function propagateGitCredentialToSandbox(opts: PropagateGitCredentialOptions): Promise<void> {
	const username = opts.gitUsername ?? "oauth2"

	// Step 1: set credential.helper = cache with 24h timeout
	await runSshCommandOnSandbox({
		remoteHost: opts.remoteHost,
		remoteUser: opts.remoteUser,
		authToken: opts.authToken,
		remoteCommand: `git config --global credential.helper ${shellEscapeValue("cache --timeout=86400")}`,
		signal: opts.signal,
		proxyCommand: opts.proxyCommand,
		_spawn: opts._spawn,
	})

	// Step 2: approve the credential by piping the key=value block via stdin.
	// Trailing blank line signals end-of-credential to git credential approve.
	const credentialBlock = Buffer.from(
		["protocol=https", `host=${opts.gitHost}`, `username=${username}`, `password=${opts.gitToken}`, "", ""].join("\n"),
		"utf-8",
	)
	await runSshCommandOnSandbox({
		remoteHost: opts.remoteHost,
		remoteUser: opts.remoteUser,
		authToken: opts.authToken,
		remoteCommand: "git credential approve",
		stdin: credentialBlock,
		signal: opts.signal,
		proxyCommand: opts.proxyCommand,
		_spawn: opts._spawn,
	})

	// Step 3: rewrite SSH URLs to HTTPS so repos with git@host: remotes
	// use the stored HTTPS credential instead of requiring an SSH key.
	await runSshCommandOnSandbox({
		remoteHost: opts.remoteHost,
		remoteUser: opts.remoteUser,
		authToken: opts.authToken,
		remoteCommand: `git config --global url.https://${opts.gitHost}/.insteadOf ${shellEscapeValue(`git@${opts.gitHost}:`)}`,
		signal: opts.signal,
		proxyCommand: opts.proxyCommand,
		_spawn: opts._spawn,
	})
}
