import { SAFETY_LIMIT_REASON, type TailSnapshot } from "./process-registry.js"

/**
 * Append a status line to the output, separated by a blank line.
 * If the output is empty, the status is returned without a leading separator.
 */
export function appendStatus(text: string, status: string): string {
	return `${text ? `${text}\n\n` : ""}${status}`
}

/** Message prefix `bash-timeout-guidance.ts` matches to append guidance. */
export const SAFETY_LIMIT_MESSAGE_PATTERN = /Process killed by the harness safety limit \((\d+)s\)/

/**
 * Inspect a tail snapshot and throw an error if the process reached a
 * terminal state that upstream bash would surface as an error:
 *  - aborted (ESC / tool-turn abort) → "Command aborted"
 *  - harness safety limit → "Process killed by the harness safety limit (Ns)"
 *  - non-zero exit code → "Command exited with code N"
 *
 * A clean exit (exit code 0) or a still-running snapshot does NOT throw.
 * Only the initial single-command `bash` path throws; consolidated batch
 * results (`bash_control`, notifications) mark each failure explicitly
 * instead of discarding sibling statuses.
 */
export function throwIfTerminal(snapshot: TailSnapshot, output: string, deadlineSeconds: number): void {
	if (snapshot.reason === "aborted") {
		throw new Error(appendStatus(output, "Command aborted"))
	}
	if (snapshot.reason === SAFETY_LIMIT_REASON) {
		throw new Error(appendStatus(output, `Process killed by the harness safety limit (${deadlineSeconds}s)`))
	}
	if (snapshot.exitCode !== null && snapshot.exitCode !== 0) {
		throw new Error(appendStatus(output, `Command exited with code ${snapshot.exitCode}`))
	}
}
