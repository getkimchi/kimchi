import type { TailSnapshot } from "./process-registry.js"

/**
 * Append a status line to the output, separated by a blank line.
 * If the output is empty, the status is returned without a leading separator.
 */
export function appendStatus(text: string, status: string): string {
	return `${text ? `${text}\n\n` : ""}${status}`
}

/**
 * Inspect a tail snapshot and throw an error if the process reached a
 * terminal state that upstream bash would surface as an error:
 *  - aborted (ESC / tool-turn abort) → "Command aborted"
 *  - deadline exceeded → "Command timed out after N seconds"
 *  - non-zero exit code → "Command exited with code N"
 *
 * A clean exit (exit code 0) or a still-running snapshot does NOT throw.
 *
 * The wording matters: `bash-timeout-guidance.ts` matches on
 * /Command timed out after (\d+) seconds/ to append actionable guidance.
 */
export function throwIfTerminal(snapshot: TailSnapshot, output: string, deadlineSeconds: number): void {
	if (snapshot.reason === "aborted") {
		throw new Error(appendStatus(output, "Command aborted"))
	}
	if (snapshot.reason === "deadline") {
		throw new Error(appendStatus(output, `Command timed out after ${deadlineSeconds} seconds`))
	}
	if (snapshot.exitCode !== null && snapshot.exitCode !== 0) {
		throw new Error(appendStatus(output, `Command exited with code ${snapshot.exitCode}`))
	}
}
