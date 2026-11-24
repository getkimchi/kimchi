import type { Args, SessionEntry } from "@earendil-works/pi-coding-agent"
import { KIMCHI_NO_PROMPT_EXIT_CODE, KIMCHI_NO_RESULT_EXIT_CODE } from "./infrastructure-error.js"

export type MessageLikeSessionEntry = Extract<SessionEntry, { type: "message" | "custom_message" }>

export interface DeniedToolOutcome {
	toolName: string
	reason: string
}

export interface RunOutcomeSnapshot {
	active: boolean
	inputSeen: boolean
	runSeen: boolean
	aborted: boolean
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
 * 6. Select lastEvent details based on what failed: denial > final message > none.
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

	// Rule 4 & 5: Analyze final entry
	// Check for denied tool first (highest priority)
	if (snapshot.deniedTool) {
		return {
			kind: "no-result",
			lastEvent: {
				kind: "denied-tool",
				toolName: snapshot.deniedTool.toolName,
				reason: snapshot.deniedTool.reason,
			},
			...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
		}
	}

	if (!snapshot.finalEntry) {
		// No final entry means no result
		return {
			kind: "no-result",
			lastEvent: { kind: "none" },
			...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
		}
	}

	// Tool result message is not a result
	if (snapshot.finalEntry.type === "message" && snapshot.finalEntry.message.role === "tool") {
		return {
			kind: "no-result",
			lastEvent: { kind: "final-message", role: "tool" },
			...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
		}
	}

	// Custom message after a run is not a result
	if (snapshot.finalEntry.type === "custom_message") {
		return {
			kind: "no-result",
			lastEvent: { kind: "final-message", role: "custom" },
			...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
		}
	}

	// Must be assistant message at this point
	if (snapshot.finalEntry.type === "message" && snapshot.finalEntry.message.role === "assistant") {
		const msg = snapshot.finalEntry.message
		const stopReason = msg.stopReason as string | undefined

		// Accept certain stop reasons
		if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
			return { kind: "ok" }
		}

		// Check for non-whitespace text content
		const content = msg.content as Array<any>
		for (const block of content) {
			if (block.type === "text" && block.text && block.text.trim().length > 0) {
				return { kind: "ok" }
			}
		}

		// No acceptable text found
		return {
			kind: "no-result",
			lastEvent: { kind: "final-message", role: "assistant", stopReason },
			...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
		}
	}

	// Fallback: treat as no-result
	return {
		kind: "no-result",
		lastEvent: { kind: "none" },
		...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
	}
}

/**
 * Format a non-ok classification into a user-facing diagnostic message.
 * Never includes model text or assistant response content.
 */
export function formatRunOutcomeDiagnostic(outcome: Exclude<RunOutcomeClassification, { kind: "ok" }>): string {
	if (outcome.kind === "no-prompt") {
		return [
			`KIMCHI_NO_PROMPT: no prompt reached the agent; exiting with code ${KIMCHI_NO_PROMPT_EXIT_CODE}.`,
			"You started pi without a question or task.",
			"Try adding a prompt: `kimchi 'what do you need?'`",
			"Or pipe input: `echo 'your prompt' | kimchi`",
		].join("\n")
	}

	// no-result case
	const lines: string[] = [
		`KIMCHI_NO_RESULT: the agent finished without a final answer; exiting with code ${KIMCHI_NO_RESULT_EXIT_CODE}.`,
	]

	// Add event details
	const { lastEvent } = outcome
	if (lastEvent.kind === "denied-tool") {
		lines.push(`The agent tried to call tool '${lastEvent.toolName}' but it was denied: ${lastEvent.reason}.`)
	} else if (lastEvent.kind === "final-message") {
		const roleText = lastEvent.role === "custom" ? "custom message" : lastEvent.role
		const stopText = lastEvent.stopReason ? ` (stop reason: ${lastEvent.stopReason})` : ""
		lines.push(`The last entry was a ${roleText}${stopText}, with no actionable content.`)
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
