import type { Args, SessionEntry } from "@earendil-works/pi-coding-agent"
import { KIMCHI_NO_PROMPT_EXIT_CODE, KIMCHI_NO_RESULT_EXIT_CODE } from "./infrastructure-error.js"

export type MessageLikeSessionEntry = Extract<SessionEntry, { type: "message" | "custom_message" }>

const BLOCK_REASON_MAX_LENGTH = 160

export interface BlockedToolOutcome {
	toolName: string
	reason: string
}

export interface RunOutcomeSnapshot {
	active: boolean
	inputSeen: boolean
	runSeen: boolean
	aborted: boolean
	/** Set when Ferment V2 wrote a live journal record during this process. */
	fermentV2Owned?: boolean
	finalEntry?: MessageLikeSessionEntry
	blockedTool?: BlockedToolOutcome
	sessionPath?: string
}

/** Everywhere a prompt can come from. pi runs a leading `/command` before any extension event, so stdin is checked directly. */
export type PromptSources = Pick<Args, "messages" | "fileArgs"> & { stdinHasText: boolean }

export type RunOutcomeLastEvent =
	| { kind: "blocked-tool"; toolName: string; reason: string }
	| { kind: "final-message"; role: string; stopReason?: string }
	| { kind: "input-handled" }
	| { kind: "none" }

export type RunOutcomeClassification =
	| { kind: "ok" }
	| { kind: "no-prompt" }
	| { kind: "no-result"; lastEvent: RunOutcomeLastEvent; sessionPath?: string }

function hasPromptSource(sources: PromptSources): boolean {
	return sources.messages.length > 0 || sources.fileArgs.length > 0 || sources.stdinHasText
}

function finalEntryEvent(entry: MessageLikeSessionEntry | undefined): RunOutcomeLastEvent | undefined {
	if (!entry) return { kind: "none" }
	if (entry.type === "custom_message") return { kind: "final-message", role: "custom" }
	const msg = entry.message
	if (msg.role !== "assistant") return { kind: "final-message", role: msg.role }
	// pi already reports these outcomes itself, so they are not silent.
	if (msg.stopReason === "error" || msg.stopReason === "aborted" || msg.stopReason === "length") return undefined
	if (msg.content.some((block) => block.type === "text" && block.text.trim().length > 0)) return undefined
	return { kind: "final-message", role: "assistant", stopReason: msg.stopReason }
}

/**
 * Applies pi's print-mode rule: only the last message-like entry counts as the
 * answer. Never copies model text into the result.
 */
export function classifyRunOutcome(snapshot: RunOutcomeSnapshot, sources: PromptSources): RunOutcomeClassification {
	if (!snapshot.active) return { kind: "ok" }

	let lastEvent: RunOutcomeLastEvent | undefined
	if (!snapshot.runSeen) {
		// Commands never emit `input`, so input without a run means an extension swallowed the prompt.
		if (snapshot.inputSeen) lastEvent = { kind: "input-handled" }
		else if (!hasPromptSource(sources)) return { kind: "no-prompt" }
		else return { kind: "ok" }
	} else {
		if (snapshot.aborted || snapshot.fermentV2Owned) return { kind: "ok" }
		lastEvent = finalEntryEvent(snapshot.finalEntry)
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
			const reason =
				collapsed.length > BLOCK_REASON_MAX_LENGTH ? `${collapsed.slice(0, BLOCK_REASON_MAX_LENGTH)}...` : collapsed
			return `The agent tried to call tool '${lastEvent.toolName}' but it was blocked: ${reason}.`
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
export function formatRunOutcomeDiagnostic(outcome: Exclude<RunOutcomeClassification, { kind: "ok" }>): string {
	if (outcome.kind === "no-prompt") {
		return [
			`KIMCHI_NO_PROMPT: no prompt reached the agent; exiting with code ${KIMCHI_NO_PROMPT_EXIT_CODE}.`,
			"A flag such as --auto may have taken the prompt as its value.",
			"Put the prompt before the flags, or write the flag as --auto=true.",
		].join("\n")
	}

	return [
		`KIMCHI_NO_RESULT: the agent finished without a final answer; exiting with code ${KIMCHI_NO_RESULT_EXIT_CODE}.`,
		describeLastEvent(outcome.lastEvent),
		...(outcome.sessionPath
			? [`Session: ${outcome.sessionPath}`, "Rerun with --mode json to see every step, or open the session file."]
			: ["No session was saved (--no-session).", "Rerun with --mode json to see every step."]),
	].join("\n")
}
