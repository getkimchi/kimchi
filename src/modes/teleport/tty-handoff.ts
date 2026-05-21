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
		// Mirror pi-tui's terminal teardown (see node_modules/@earendil-works/pi-tui/dist/terminal.js
		// stop()/drainInput()). If we don't pop these modes, kitty-encoded keystrokes leak
		// into the child as `CSI <code>;<mod>:<event>u` and bracketed-paste markers wrap input.
		// `?1049h` enters the alternate screen buffer (saves cursor + main screen) so the
		// child gets a clean canvas; `?1049l` on the return path restores the kimchi UI
		// exactly as it was. pi-tui doesn't use the alt screen, so this nests cleanly.
		process.stdout.write(
			"\x1b[?2004l" + // disable bracketed paste
				"\x1b[<u" + // pop kitty keyboard protocol
				"\x1b[>4;0m" + // disable modifyOtherKeys
				"\x1b[?1049h" + // enter alternate screen (saves main screen + cursor)
				"\x1b[?25h" + // show cursor
				"\x1b[0m" + // reset SGR
				"\x1b[H", // cursor home in the alt buffer
		)
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

	// Silence pi-tui's continuous renders for the duration of the child.
	// `stdio: "inherit"` plumbs the child's stdout directly to the parent's fd
	// at the OS level, bypassing JS — so a no-op here suppresses pi-tui without
	// affecting the child's output.
	const realStdoutWrite = process.stdout.write.bind(process.stdout)
	const realStderrWrite = process.stderr.write.bind(process.stderr)
	const noopWrite: typeof process.stdout.write = ((..._args: unknown[]) => true) as typeof process.stdout.write
	try {
		;(process.stdout as { write: typeof process.stdout.write }).write = noopWrite
		;(process.stderr as { write: typeof process.stderr.write }).write = noopWrite
	} catch {
		// best-effort
	}

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
			;(process.stdout as { write: typeof process.stdout.write }).write = realStdoutWrite
			;(process.stderr as { write: typeof process.stderr.write }).write = realStderrWrite
		} catch {
			// best-effort
		}
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
			// Exit the alt screen first so the main screen + cursor are restored.
			// Then re-enable pi-tui's terminal modes so the TUI keeps working post-child.
			// pi-tui's internal flags stay set across this excursion, so re-emitting
			// the enables keeps the terminal and the parser in sync. SIGWINCH below
			// covers the case where the user resized the terminal during the child.
			process.stdout.write(
				"\x1b[?1049l" + // leave alternate screen (restores main screen + cursor)
					"\x1b[?2004h" + // bracketed paste back on
					"\x1b[>7u" + // kitty keyboard push (flags 7)
					"\x1b[?25l", // hide cursor
			)
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
