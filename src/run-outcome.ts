import type { Args, SessionEntry } from "@earendil-works/pi-coding-agent"
import { KIMCHI_NO_PROMPT_EXIT_CODE, KIMCHI_NO_RESULT_EXIT_CODE } from "./infrastructure-error.js"

export type MessageLikeSessionEntry = Extract<SessionEntry, { type: "message" | "custom_message" }>

const DENIAL_REASON_MAX_LENGTH = 160

export interface DeniedToolOutcome {
	toolName: string
	reason: string
}

export interface RunOutcomeSnapshot {
	active: boolean
	inputSeen: boolean
	runSeen: boolean
	aborted: boolean
	/** Set when the settled session branch ends with a live Ferment V2 journal record. */
	fermentV2Owned?: boolean
	finalEntry?: MessageLikeSessionEntry
	deniedTool?: DeniedToolOutcome
	sessionPath?: string
}

export type RunOutcomeClassification =
	| { kind: "ok" }
	| { kind: "no-prompt" }
	| {
			kind: "no-result"
			lastEvent:
				| { kind: "denied-tool"; toolName: string; reason: string }
				| { kind: "final-message"; role: string; stopReason?: string }
				| { kind: "none" }
			sessionPath?: string
	  }

/**
 * Pure classifier for silent non-interactive runs.
 *
 * Rules:
 * 1. Inactive snapshots always return ok.
 * 2. If no run occurred, check for parsed prompt or piped input:
 *    - Return no-prompt only if both messages and fileArgs are empty, no input was seen, and no run occurred.
 *    - Otherwise return ok (covering parsed commands, at-files, or piped input cases).
 * 3. If the run was aborted, return ok.
 * 4. For a settled assistant message:
 *    - Accept (return ok) for stop reasons: error, aborted, length.
 *    - Otherwise, accept only if at least one text block has non-whitespace content.
 * 5. All other message types (tool result, custom message) or no message return no-result.
 * 6. If the classification is no-result and a denial occurred, use denial to select lastEvent detail.
 * 7. Never include model text in the classification result.
 */
export function classifyRunOutcome(
	snapshot: RunOutcomeSnapshot,
	parsedArgs: Pick<Args, "messages" | "fileArgs">,
): RunOutcomeClassification {
	// Rule 1: Inactive always ok
	if (!snapshot.active) {
		return { kind: "ok" }
	}

	// Rule 2: No run - check for prompt or input
	if (!snapshot.runSeen) {
		const hasMessages = parsedArgs.messages.length > 0
		const hasFileArgs = parsedArgs.fileArgs.length > 0
		const hasInput = snapshot.inputSeen

		// no-prompt only if truly empty and no input
		if (!hasMessages && !hasFileArgs && !hasInput) {
			return { kind: "no-prompt" }
		}

		// Otherwise ok (parsed command, at-file, or piped input)
		return { kind: "ok" }
	}

	// Rule 3: Aborted settled run is ok
	if (snapshot.aborted) {
		return { kind: "ok" }
	}

	// Ferment V2 headless runs end on control/tool entries by design and own their exit code.
	if (snapshot.fermentV2Owned) {
		return { kind: "ok" }
	}

	// Rule 4 & 5: Determine classification based on final entry shape
	// First, classify the final entry without considering denial

	let classifiedOutcome: RunOutcomeClassification

	if (!snapshot.finalEntry) {
		// No final entry means no result
		classifiedOutcome = {
			kind: "no-result",
			lastEvent: { kind: "none" },
			...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
		}
	} else if (snapshot.finalEntry.type === "message") {
		const msg = snapshot.finalEntry.message
		if (msg.role === "assistant") {
			const stopReason = msg.stopReason
			// Accept certain stop reasons
			if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
				classifiedOutcome = { kind: "ok" }
			} else if (msg.content.some((block) => block.type === "text" && block.text.trim().length > 0)) {
				classifiedOutcome = { kind: "ok" }
			} else {
				classifiedOutcome = {
					kind: "no-result",
					lastEvent: { kind: "final-message", role: "assistant", stopReason },
					...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
				}
			}
		} else {
			// Non-assistant message (user, toolResult, bashExecution, etc.)
			classifiedOutcome = {
				kind: "no-result",
				lastEvent: { kind: "final-message", role: msg.role },
				...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
			}
		}
	} else {
		// Custom message after a run is not a result
		classifiedOutcome = {
			kind: "no-result",
			lastEvent: { kind: "final-message", role: "custom" },
			...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
		}
	}

	// Now, if the classification is no-result and we have a denial, use it to select lastEvent detail
	if (classifiedOutcome.kind === "no-result" && snapshot.deniedTool) {
		classifiedOutcome.lastEvent = {
			kind: "denied-tool",
			toolName: snapshot.deniedTool.toolName,
			reason: snapshot.deniedTool.reason,
		}
	}

	return classifiedOutcome
}

/**
 * Format a non-ok classification into a user-facing diagnostic message.
 * Never includes model text or assistant response content.
 */
export function formatRunOutcomeDiagnostic(outcome: Exclude<RunOutcomeClassification, { kind: "ok" }>): string {
	if (outcome.kind === "no-prompt") {
		return [
			`KIMCHI_NO_PROMPT: no prompt reached the agent; exiting with code ${KIMCHI_NO_PROMPT_EXIT_CODE}.`,
			"A flag such as --auto may have taken the prompt as its value.",
			"Put the prompt before the flags, or write the flag as --auto=true.",
		].join("\n")
	}

	// no-result case
	const lines: string[] = [
		`KIMCHI_NO_RESULT: the agent finished without a final answer; exiting with code ${KIMCHI_NO_RESULT_EXIT_CODE}.`,
	]

	// Add event details
	const { lastEvent } = outcome
	if (lastEvent.kind === "denied-tool") {
		const collapsed = lastEvent.reason.replace(/\s+/g, " ").trim()
		const reason =
			collapsed.length > DENIAL_REASON_MAX_LENGTH ? `${collapsed.slice(0, DENIAL_REASON_MAX_LENGTH)}...` : collapsed
		lines.push(`The agent tried to call tool '${lastEvent.toolName}' but it was denied: ${reason}.`)
	} else if (lastEvent.kind === "final-message") {
		const entryText = lastEvent.role === "custom" ? "a custom message" : `an entry with role '${lastEvent.role}'`
		const stopText = lastEvent.stopReason ? ` (stop reason: ${lastEvent.stopReason})` : ""
		lines.push(`The last entry was ${entryText}${stopText}, with no actionable content.`)
	} else {
		lines.push("The agent produced no message or action.")
	}

	// Add session info
	if (outcome.sessionPath) {
		lines.push(`Session: ${outcome.sessionPath}`)
	} else {
		lines.push("No session was saved (--no-session).")
	}

	// Add rerun hint
	if (outcome.sessionPath) {
		lines.push("Rerun with --mode json to see every step, or open the session file.")
	} else {
		lines.push("Rerun with --mode json to see every step.")
	}

	return lines.join("\n")
}
