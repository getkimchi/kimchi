import type { SessionEntry } from "@earendil-works/pi-coding-agent"

export const KIMCHI_NO_PROMPT_EXIT_CODE = 2
export const KIMCHI_NO_RESULT_EXIT_CODE = 3

export type MessageLikeSessionEntry = Extract<SessionEntry, { type: "message" | "custom_message" }>

export interface BlockedToolOutcome {
	toolName: string
	reason: string
}

export interface RunOutcomeSnapshot {
	active: boolean
	promptSeen: boolean
	inputSeen: boolean
	runSeen: boolean
	aborted: boolean
	/** Set when Ferment V2 wrote a live journal record during this process. */
	fermentV2Owned?: boolean
	finalEntry?: MessageLikeSessionEntry
	blockedTool?: BlockedToolOutcome
	sessionPath?: string
}

export type RunOutcomeLastEvent =
	| { kind: "blocked-tool"; toolName: string; reason: string }
	| { kind: "final-message"; role: string; stopReason?: string }
	| { kind: "input-handled" }
	| { kind: "none" }

export type RunOutcomeClassification =
	| { kind: "ok" }
	| { kind: "failed"; stopReason: "error" | "aborted" | "length"; diagnostic: string }
	| { kind: "no-prompt" }
	| { kind: "no-result"; lastEvent: RunOutcomeLastEvent; sessionPath?: string }

function finalEntryEvent(entry: MessageLikeSessionEntry | undefined): RunOutcomeLastEvent | undefined {
	if (!entry) return { kind: "none" }
	if (entry.type === "custom_message") return { kind: "final-message", role: "custom" }
	const msg = entry.message
	if (msg.role !== "assistant") return { kind: "final-message", role: msg.role }
	if (msg.content.some((block) => block.type === "text" && block.text.trim().length > 0)) return undefined
	return { kind: "final-message", role: "assistant", stopReason: msg.stopReason }
}

/**
 * Applies pi's print-mode rule: only the last message-like entry counts as the
 * answer. Never copies model text into the result.
 */
export function classifyRunOutcome(snapshot: RunOutcomeSnapshot): RunOutcomeClassification {
	if (!snapshot.active) return { kind: "ok" }

	let lastEvent: RunOutcomeLastEvent | undefined
	if (!snapshot.runSeen) {
		if (snapshot.inputSeen) lastEvent = { kind: "input-handled" }
		// pi calls prompt for `/commands` too, but commands never emit `input`.
		else if (!snapshot.promptSeen) return { kind: "no-prompt" }
		else return { kind: "ok" }
	} else {
		if (snapshot.fermentV2Owned) return { kind: "ok" }
		const finalEntry = snapshot.finalEntry
		if (finalEntry?.type === "message" && finalEntry.message.role === "assistant") {
			const stopReason = finalEntry.message.stopReason
			if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
				const diagnostic =
					stopReason === "length"
						? "Response was truncated: the model reached its output token limit."
						: (finalEntry.message.errorMessage ?? `Request ${stopReason}`)
				return { kind: "failed", stopReason, diagnostic }
			}
		}
		if (snapshot.aborted) return { kind: "ok" }
		lastEvent = finalEntryEvent(finalEntry)
		if (!lastEvent) return { kind: "ok" }
		// The block explains the empty answer better than the shape of the last entry.
		if (snapshot.blockedTool) lastEvent = { kind: "blocked-tool", ...snapshot.blockedTool }
	}

	return {
		kind: "no-result",
		lastEvent,
		...(snapshot.sessionPath ? { sessionPath: snapshot.sessionPath } : {}),
	}
}

function describeLastEvent(lastEvent: RunOutcomeLastEvent): string {
	switch (lastEvent.kind) {
		case "blocked-tool": {
			const collapsed = lastEvent.reason.replace(/\s+/g, " ").trim()
			return `The agent tried to call tool '${lastEvent.toolName}' but it was blocked: ${collapsed || "(no reason recorded)"}.`
		}
		case "final-message": {
			const entryText = lastEvent.role === "custom" ? "a custom message" : `an entry with role '${lastEvent.role}'`
			const stopText = lastEvent.stopReason ? ` (stop reason: ${lastEvent.stopReason})` : ""
			return `The last entry was ${entryText}${stopText}, with no actionable content.`
		}
		case "input-handled":
			return "An extension handled the prompt, so the agent did not run."
		case "none":
			return "The agent produced no message or action."
	}
}

/** Never includes model text. */
export function formatRunOutcomeDiagnostic(
	outcome: Exclude<RunOutcomeClassification, { kind: "ok" | "failed" }>,
): string {
	if (outcome.kind === "no-prompt") {
		return [
			`KIMCHI_NO_PROMPT: no prompt reached the agent; exiting with code ${KIMCHI_NO_PROMPT_EXIT_CODE}.`,
			"An empty prompt or an empty @file does not count as a prompt.",
			"A flag that needs a value, such as --model, may have taken the prompt as its value.",
			"Give each such flag its own value, or put the prompt before the flags.",
		].join("\n")
	}

	return [
		`KIMCHI_NO_RESULT: the agent finished without a final answer; exiting with code ${KIMCHI_NO_RESULT_EXIT_CODE}.`,
		describeLastEvent(outcome.lastEvent),
		...(outcome.sessionPath
			? [
					`Session: ${outcome.sessionPath.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`,
					"Rerun with --mode json to see every step, or open the session file.",
				]
			: ["No session was saved (--no-session).", "Rerun with --mode json to see every step."]),
	].join("\n")
}
