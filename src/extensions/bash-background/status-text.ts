/**
 * Model-visible status and result text for the background-bash cohort.
 *
 * Design: this text is the interface the model sees right before it
 * chooses its next tool call, so it must make the continuation contract
 * explicit — processes continue by default, reviews and exits arrive
 * automatically, and `bash_control` exists to stop selected processes or
 * to block when the agent has no other work (never to poll per process).
 *
 * Facts are reported factually: "no new output observed" is an
 * observation, never a claim like "no progress".
 */
import { relative } from "node:path"
import type { IncrementalSnapshot, ProcessEntry, ProcessState } from "./process-registry.js"
import { elapsedSecondsSince, SAFETY_LIMIT_REASON } from "./process-registry.js"

/** Human-readable byte count for status lines (e.g. "18 KB"). */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Facts block describing one running process: handle, command summary,
 * working directory (when it differs from the session cwd), elapsed
 * runtime, and output activity (new/total bytes, last output age).
 *
 * The cwd line is shown only when it carries information the model cannot
 * assume: when the process runs somewhere other than the session cwd it is
 * rendered project-relative, falling back to the absolute path outside the
 * project.
 */
export function runningFactsText(
	entry: Readonly<ProcessEntry>,
	incremental: IncrementalSnapshot,
	sessionCwd?: string,
): string {
	const elapsed = elapsedSecondsSince(entry.spawnedAtMs)
	const lines = ["[Background bash process", ` handle: ${entry.handle}`, ` command: ${entry.commandSummary}`]
	if (sessionCwd) {
		const rel = relative(sessionCwd, entry.cwd)
		if (rel !== "") lines.push(` cwd: ${rel.startsWith("..") ? entry.cwd : rel}`)
	}
	lines.push(` running: ${elapsed}s`)
	const activity =
		incremental.newBytes > 0
			? `${formatBytes(incremental.newBytes)} new; ${formatBytes(incremental.totalBytes)} total`
			: `no new output observed; ${formatBytes(incremental.totalBytes)} total`
	const lastOutput =
		entry.lastOutputAtMs === undefined
			? "no output yet"
			: `last output ${Math.max(0, Math.floor((Date.now() - entry.lastOutputAtMs) / 1000))}s ago`
	lines.push(` output activity: ${activity}; ${lastOutput}`)
	lines.push("]")
	return lines.join("\n")
}

/** The output section following a facts block in a review/wait result. */
export function unseenOutputText(incremental: IncrementalSnapshot): string {
	const parts: string[] = []
	if (incremental.omittedBytes > 0) {
		parts.push(
			`[${formatBytes(incremental.omittedBytes)} of older unseen output omitted from this snapshot; if final output is truncated, the full-output file retains everything.]`,
		)
	}
	if (incremental.newBytes > 0 && incremental.text.length > 0) {
		parts.push("New output since the previous delivery:")
		parts.push(incremental.text)
	} else if (incremental.newBytes > 0) {
		parts.push("[New output was produced but evicted from the in-memory buffer before delivery.]")
	} else {
		parts.push("No new output since the previous delivery.")
	}
	return parts.join("\n")
}

/** Full running-status text for a tool result: facts + unseen output. */
export function runningResultText(
	entry: Readonly<ProcessEntry>,
	incremental: IncrementalSnapshot,
	sessionCwd?: string,
): string {
	return `${runningFactsText(entry, incremental, sessionCwd)}\n\n${unseenOutputText(incremental)}`
}

/** Terminal-state label shared by all terminal formatters. */
export function terminalReasonText(state: ProcessState, exitCode: number | null, reason: string | null): string {
	if (reason === SAFETY_LIMIT_REASON) return "killed by the harness safety limit"
	if (reason === "stop") return "stopped on request"
	if (reason === "aborted") return "aborted"
	if (reason) return `killed (${reason})`
	if (state === "exited") return `exited (exit code ${exitCode ?? "unknown"})`
	return `ended (exit code ${exitCode ?? "unknown"})`
}

export interface TerminalResultInput {
	/** Background identity; omitted when the process never reached handoff (e.g. a pre-handoff `bash` exit). */
	handle?: string
	commandSummary?: string
	elapsedSeconds: number
	state: ProcessState
	exitCode: number | null
	reason: string | null
	/** Safety limit in seconds (for the safety-limit guidance line). */
	deadlineSeconds: number
	/** Final output text (already de-duplicated against delivered output). */
	output: string
	/** True when the full output exceeded the truncation budget. */
	truncated?: boolean
	/** Spill-file path for truncated output. */
	fullOutputPath?: string
}

/**
 * One terminal result block. Used by pre-handoff `bash` exits,
 * `bash_control` stop/wait results, and unattended exit notifications —
 * every terminal path formats through here so the agent always sees the
 * identical contract.
 */
export function terminalResultText(input: TerminalResultInput): string {
	const reasonText = terminalReasonText(input.state, input.exitCode, input.reason)
	const header = input.handle
		? [
				"[Background bash process ended",
				` handle: ${input.handle}`,
				` command: ${input.commandSummary}`,
				` terminal: ${reasonText}; ran for ${input.elapsedSeconds}s`,
				"]",
			].join("\n")
		: `[Process ${reasonText}; ran for ${input.elapsedSeconds}s.]`
	const parts = [header]
	if (input.output.length > 0) {
		parts.push("Final output:")
		parts.push(input.output)
	} else if (input.truncated) {
		parts.push("All output was already delivered in previous reviews.")
	} else {
		parts.push("The process produced no further output.")
	}
	if (input.truncated && input.fullOutputPath) {
		parts.push(`[Output truncated. Full output: ${input.fullOutputPath}]`)
	}
	if (input.reason === SAFETY_LIMIT_REASON) {
		parts.push(
			`[This process reached the ${input.deadlineSeconds}s harness safety limit. Break the work into smaller commands or run a bounded subset first. Servers and watchers that must run indefinitely belong in the daemon mechanism, not background bash.]`,
		)
	}
	return parts.join("\n")
}

/**
 * Guidance appended to a result that yields a live handle. States the
 * continuation contract once, without recommending polling.
 */
export function handoffGuidanceText(): string {
	return (
		"[This process now continues by default. You will receive its cohort review " +
		"and its exit result automatically — do not poll it. Do independent work " +
		"with the other tools now, avoiding commands or edits that could conflict " +
		"with it (same files, package managers, ports, generated output). Call " +
		"bash_control only to stop specific handles, or with wait: true when you " +
		"genuinely have no other work until something changes. Intentional " +
		"servers/watchers that must outlive the session belong in daemon management.]"
	)
}
