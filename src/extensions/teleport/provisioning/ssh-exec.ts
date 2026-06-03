import { spawn } from "node:child_process"
import { buildProxyCommand } from "./proxy-command.js"

/**
 * Single-quote a value for safe inclusion in a remote shell command.
 * Inner single quotes are escaped as `'\''`.
 */
export function shellEscapeValue(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`
}

export interface RunSshCommandOptions {
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
	/** Override for the proxy command (test seam). */
	proxyCommand?: string
	/** Test seam: injectable spawner. */
	_spawn?: typeof spawn
}

/**
 * Run a single command on the remote sandbox via the WS-SSH proxy tunnel.
 * Resolves on exit code 0, rejects with an Error containing stderr on non-zero.
 */
export function runSshCommandOnSandbox(opts: RunSshCommandOptions): Promise<void> {
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
