// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process"
import { findBinary } from "./detect.js"

/**
 * Run a third-party CLI (claude, opencode, …) in the foreground with the
 * current terminal attached. Inherits stdio so the child owns the TTY,
 * forwards SIGINT/SIGTERM/SIGHUP, and resolves with the child's exit code.
 *
 * Node can't replace the current process the way a Unix `exec` would, so
 * kimchi stays alive while the child runs. Fine for a launcher subcommand
 * since we exit immediately after the child exits anyway.
 */
export async function runForeground(
	binaryName: string,
	args: string[],
	env: Record<string, string> = {},
): Promise<number> {
	const path = findBinary(binaryName)
	if (!path) {
		throw new Error(`${binaryName} is not installed or not on PATH`)
	}

	return new Promise((resolve, reject) => {
		const child = nodeSpawn(path, args, {
			stdio: "inherit",
			env: { ...process.env, ...env },
		})
		const handler = (signal: NodeJS.Signals) => () => forwardSignal(child, signal)
		const sigInt = handler("SIGINT")
		const sigTerm = handler("SIGTERM")
		const sigHup = handler("SIGHUP")
		process.on("SIGINT", sigInt)
		process.on("SIGTERM", sigTerm)
		process.on("SIGHUP", sigHup)

		const cleanup = () => {
			process.off("SIGINT", sigInt)
			process.off("SIGTERM", sigTerm)
			process.off("SIGHUP", sigHup)
		}

		child.on("error", (err) => {
			cleanup()
			reject(err)
		})
		child.on("exit", (code, signal) => {
			cleanup()
			if (code !== null) {
				resolve(code)
			} else if (signal) {
				// Process killed by a signal — re-raise it on ourselves so the
				// caller's parent shell sees the same exit semantics it would
				// have seen running the binary directly. Fallback to 130 (SIGINT)
				// when re-raise isn't possible.
				try {
					process.kill(process.pid, signal)
					// Should not return; if it does, fall through to a sensible code.
					resolve(128 + signalToNumber(signal))
				} catch {
					resolve(128 + signalToNumber(signal))
				}
			} else {
				resolve(0)
			}
		})
	})
}

function forwardSignal(child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		child.kill(signal)
	} catch {
		// Child already exited
	}
}

function signalToNumber(sig: NodeJS.Signals): number {
	switch (sig) {
		case "SIGHUP":
			return 1
		case "SIGINT":
			return 2
		case "SIGTERM":
			return 15
		default:
			return 0
	}
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker

export const DUMB_TEST_MARKER_LLM_4329 = "llm-4329-dumb-test-marker"
