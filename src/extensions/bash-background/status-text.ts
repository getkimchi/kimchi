/**
 * Model-visible status-line text shared by the background `bash` tool and
 * the `bash_control` companion.
 *
 * Design: the status text is the interface the model sees right before it
 * chooses its next tool call, so it must make the non-blocking contract
 * explicit — the process keeps running, other tools stay available, and
 * `bash_control` is for output/deadline/stop decisions, not for waiting.
 * It must NOT tell the model to call `bash_control` unconditionally
 * (that recreates the busy-polling loop this design removes) and must not
 * claim other tools were ever blocked.
 */

/** Status line appended to a still-running background process result. */
export function runningStatusText(handle: string, elapsedSeconds: number, continued: boolean): string {
	const lead = continued ? "Background process still running" : "Background process running"
	return (
		`[${lead} for ${elapsedSeconds}s (handle ${handle}). ` +
		"Other tools remain available: do independent work now instead of calling bash_control just to wait. " +
		"Avoid commands or edits that could conflict with the running process (same files, package managers, ports, generated output). " +
		"Call bash_control with this handle when you need output sooner, a new checkin, a deadline extension, or to stop it.]"
	)
}

/** Status line appended to an observed-exit result. */
export function exitedStatusText(exitCode: number | null, elapsedSeconds: number): string {
	const code = exitCode !== null ? `; exit code ${exitCode}` : ""
	return `[Process exited${code}; ran for ${elapsedSeconds}s.]`
}

/** Status line appended to a stop result. */
export function stoppedStatusText(exitCode: number | null, elapsedSeconds: number): string {
	const code = exitCode !== null ? `; exit code ${exitCode}` : ""
	return `[Process stopped${code}; ran for ${elapsedSeconds}s.]`
}
