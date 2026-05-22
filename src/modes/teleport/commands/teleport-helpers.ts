import { exec, spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { promisify } from "node:util"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { buildProxyCommand } from "../proxy/proxy-command.js"
import { FALLBACK_TARGET_NAME, SANDBOX_HOME } from "./types.js"

const execAsync = promisify(exec)

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms)
		if (signal) {
			const onAbort = () => {
				clearTimeout(t)
				reject(new Error("aborted"))
			}
			if (signal.aborted) onAbort()
			else signal.addEventListener("abort", onAbort, { once: true })
		}
	})
}

export async function waitUntilIdle(check: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (check()) return true
		try {
			await sleep(100, signal)
		} catch {
			return check()
		}
	}
	return check()
}

export function isBusy(session: AgentSession): boolean {
	if ((session as { isStreaming?: boolean }).isStreaming) return true
	if ((session as { isBashRunning?: boolean }).isBashRunning) return true
	if ((session as { hasPendingBashMessages?: boolean }).hasPendingBashMessages) return true
	return false
}

export async function whichRsync(): Promise<boolean> {
	try {
		await execAsync("command -v rsync")
		return true
	} catch {
		return false
	}
}

export async function estimateWorkspaceBytes(cwd: string): Promise<number> {
	try {
		const { stdout } = await execAsync(`du -sk "${cwd}"`, { maxBuffer: 1024 * 1024 })
		const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? "0", 10)
		return Number.isFinite(kb) ? kb * 1024 : 0
	} catch {
		return 0
	}
}

export async function gitWorkingTreeDirty(cwd: string): Promise<boolean> {
	try {
		const { stdout } = await execAsync(`git -C "${cwd}" status --porcelain`)
		return stdout.trim().length > 0
	} catch {
		return false
	}
}

export function rsyncInstallHint(): string {
	if (process.platform === "darwin") return "Install with: brew install rsync"
	if (process.platform === "linux") return "Install with your package manager (e.g. apt install rsync)"
	return "Install rsync and ensure it is on PATH"
}

export function deriveSandboxDest(localCwd: string): string {
	const { basename } = require("node:path")
	const trimmed = localCwd.replace(/\/+$/, "")
	const raw = basename(trimmed)
	const cleaned = raw.replace(/[/\0]/g, "_")
	const name = cleaned.length > 0 && cleaned !== "." ? cleaned : FALLBACK_TARGET_NAME
	return `${SANDBOX_HOME}/${name}/`
}

// ── Git config propagation ──────────────────────────────────────────────────

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
	} catch (err) {}
	try {
		const { stdout } = await execAsync(`git -C "${cwd}" config user.email`)
		const trimmed = stdout.trim()
		if (trimmed) email = trimmed
	} catch (err) {}
	return { name, email }
}

/**
 * Single-quote a value for safe inclusion in a remote shell command.
 * Inner single quotes are escaped as `'\''`.
 */
function shellEscapeValue(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`
}

interface RunSshCommandOptions {
	remoteHost: string
	remoteUser: string
	authToken: string
	/**
	 * Full remote command passed as a **single SSH argument**. SSH sends this
	 * string to the remote shell as `$SSH_ORIGINAL_COMMAND`, which the shell
	 * interprets — so `&&`, `|`, and other shell operators work.
	 *
	 * IMPORTANT: when SSH receives multiple positional args after the host, it
	 * concatenates them with spaces into one string. Passing the command as a
	 * single arg avoids subtle word-splitting issues with values that contain
	 * spaces (e.g. user names).
	 */
	remoteCommand: string
	/**
	 * Optional data to write to the SSH process stdin (e.g. for `git credential approve`).
	 * When provided, stdio[0] is set to "pipe" and this buffer is written then closed.
	 */
	stdin?: Buffer
	signal?: AbortSignal
	proxyCommand?: string
	_spawn?: typeof spawn
}

/**
 * Run a single command on the remote sandbox via the WS-SSH proxy tunnel.
 * Resolves on exit code 0, rejects with an Error containing stderr on non-zero.
 */
function runSshCommandOnSandbox(opts: RunSshCommandOptions): Promise<void> {
	const proxyCommand = opts.proxyCommand ?? buildProxyCommand()
	const sshArgs = [
		"-T", // no pseudo-terminal — we're running a batch command, not an interactive shell
		"-o",
		`ProxyCommand=${proxyCommand}`,
		"-o",
		"StrictHostKeyChecking=no",
		"-o",
		"UserKnownHostsFile=/dev/null",
		"-o",
		"BatchMode=yes",
		"-o",
		"LogLevel=ERROR",
		`${opts.remoteUser}@${opts.remoteHost}`,
		opts.remoteCommand,
	]
	const env: NodeJS.ProcessEnv = { ...process.env, AUTH_TOKEN: opts.authToken }
	const spawner = opts._spawn ?? spawn

	return new Promise((resolve, reject) => {
		let stdout = ""
		let stderr = ""
		const child = spawner("ssh", sshArgs, {
			env,
			signal: opts.signal,
			stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
		})
		if (opts.stdin && child.stdin) {
			// Write data but delay closing stdin. SSH needs time to establish
			// the exec channel before it reads. Closing immediately causes
			// a broken pipe (the pipe is torn down before SSH reads it).
			const stdinStream = child.stdin
			let stdinEnded = false
			const endStdin = () => {
				if (stdinEnded) return
				stdinEnded = true
				stdinStream.end()
			}
			stdinStream.write(opts.stdin)
			// End stdin once the remote produces any output (channel is open),
			// or after a short delay as a fallback for silent commands.
			child.stdout?.once("data", endStdin)
			child.stderr?.once("data", endStdin)
			child.on("close", endStdin)
			setTimeout(endStdin, 500)
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf-8")
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8")
		})
		child.on("error", (err) => {
			reject(err)
		})
		child.on("close", (code) => {
			if (code === 0) resolve()
			else {
				const msg = stderr.trim() || stdout.trim()
				reject(new Error(msg ? `ssh exited with code ${code}: ${msg}` : `ssh exited with code ${code}`))
			}
		})
	})
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

// ── Git clone on sandbox ────────────────────────────────────────────────────

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
