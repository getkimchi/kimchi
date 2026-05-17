import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process"

export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface RunChildOptions {
	cmd: string
	args: string[]
	env?: NodeJS.ProcessEnv
	signal?: AbortSignal
	_spawn?: SpawnLike
}

/**
 * Hand off the controlling terminal to a child process and resume the kimchi
 * TUI when it exits.
 *
 * pi-mono's `InteractiveMode` does not expose a pause/resume API, so this is
 * a best-effort approach: drop raw mode on the parent's stdin, run the child
 * with `stdio: "inherit"` so it owns the TTY, then restore raw mode and kick
 * a SIGWINCH so pi-tui's resize-driven redraw repaints the screen.
 *
 * Returns the child's exit code (128 if killed by a signal).
 */
export async function runChildWithTTYHandoff(opts: RunChildOptions): Promise<number> {
	const spawner: SpawnLike = opts._spawn ?? (spawn as unknown as SpawnLike)
	const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (mode: boolean) => void }
	const wasRaw = !!stdin.isRaw

	try {
		if (wasRaw && typeof stdin.setRawMode === "function") stdin.setRawMode(false)
	} catch {
		// best-effort
	}
	try {
		stdin.pause()
	} catch {
		// best-effort
	}
	try {
		process.stdout.write("\x1b[?25h")
	} catch {
		// best-effort
	}

	let child: ChildProcess | undefined
	const onAbort = () => {
		try {
			child?.kill("SIGTERM")
		} catch {
			// ignore
		}
	}
	opts.signal?.addEventListener("abort", onAbort, { once: true })

	try {
		return await new Promise<number>((resolve, reject) => {
			child = spawner(opts.cmd, opts.args, {
				stdio: "inherit",
				env: opts.env ?? process.env,
			})
			child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 0)))
			child.on("error", reject)
		})
	} finally {
		opts.signal?.removeEventListener("abort", onAbort)
		try {
			stdin.resume()
		} catch {
			// best-effort
		}
		try {
			if (wasRaw && typeof stdin.setRawMode === "function") stdin.setRawMode(true)
		} catch {
			// best-effort
		}
		try {
			process.stdout.write("\x1b[?25l")
		} catch {
			// best-effort
		}
		try {
			process.kill(process.pid, "SIGWINCH")
		} catch {
			// best-effort
		}
	}
}
