import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { AgentEndEvent, SessionEntry } from "@earendil-works/pi-coding-agent"
import { ASSISTANT_OUTPUT_WITHHELD } from "../orchestration/continuation-nudge.js"
import { isHarnessSteer, SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "../steer-marker.js"
import { FERMENT_V2_CONTROL_MESSAGE_TYPE } from "./constants.js"
import { isRecord } from "./reducer.js"
import type { PendingFermentV2Continuation, SessionFermentV2 } from "./types.js"

type FermentV2Message = AgentEndEvent["messages"][number]

export type CompletionCandidate = PendingFermentV2Continuation & {
	message: AssistantMessage
	withheld: boolean
}

export type AcceptedFinalAnswerDraft = PendingFermentV2Continuation & {
	draft: string
	alreadyVisible: boolean
}

type WithheldAssistantMessage = {
	[ASSISTANT_OUTPUT_WITHHELD]?: boolean
}

const FINAL_ANSWER_PROMPT = `The objective is complete and ready for user delivery.

Give the user only the final answer to the original objective. If the original objective requires exact output, return exactly that output with no preface or summary. Otherwise, start with the outcome. Do not narrate the completion check, control messages, evidence gathering, or your internal process unless directly required by the original objective. Do not call tools.`
const FINAL_ANSWER_DRAFT_PREFIX = "Return this evaluated draft verbatim: "

export function finalAnswerPrompt(evaluatedDraft?: string): string {
	return evaluatedDraft
		? `${FINAL_ANSWER_PROMPT}\n\n${FINAL_ANSWER_DRAFT_PREFIX}${JSON.stringify(evaluatedDraft)}`
		: FINAL_ANSWER_PROMPT
}

export function parseAcceptedFinalAnswerDraft(content: string): string | undefined {
	const prompt = unwrapHarnessSteer(content)
	const markerIndex = prompt.lastIndexOf(FINAL_ANSWER_DRAFT_PREFIX)
	if (markerIndex < 0) return undefined
	try {
		const value = JSON.parse(prompt.slice(markerIndex + FINAL_ANSWER_DRAFT_PREFIX.length).trim())
		return typeof value === "string" && value.trim().length > 0 && finalAnswerPrompt(value) === prompt
			? value
			: undefined
	} catch {
		return undefined
	}
}

function unwrapHarnessSteer(content: string): string {
	return isHarnessSteer(content) ? content.slice(SYSTEM_REMINDER_OPEN.length, -SYSTEM_REMINDER_CLOSE.length) : content
}

export function latestFinalAnswerDraft(messages: readonly FermentV2Message[]): string | undefined {
	return latestFinalAnswerDraftEntry(messages)?.draft
}

export function latestFinalAnswerDraftEntry(
	messages: readonly FermentV2Message[],
): { draft: string; visible: boolean } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message?.role !== "assistant" || message.content.some((block) => block.type === "toolCall")) continue
		const text = message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("")
			.trim()
		if (text) {
			return {
				draft: text,
				visible: (message as unknown as WithheldAssistantMessage)[ASSISTANT_OUTPUT_WITHHELD] !== true,
			}
		}
	}
	return undefined
}

export function clearAssistantText(message: FermentV2Message): void {
	if (message.role !== "assistant") return
	for (const block of message.content) {
		if (block.type === "text") block.text = ""
	}
}

export function recoverAcceptedFinalAnswerDraft(
	entries: readonly SessionEntry[],
	fermentV2: SessionFermentV2 | undefined,
	sessionId: string | undefined,
): AcceptedFinalAnswerDraft | undefined {
	if (!fermentV2 || !sessionId) return undefined
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]
		if (
			!isRecord(entry) ||
			entry.type !== "custom_message" ||
			entry.customType !== FERMENT_V2_CONTROL_MESSAGE_TYPE ||
			entry.display !== false ||
			typeof entry.content !== "string" ||
			!isRecord(entry.details) ||
			entry.details.source !== "evaluation_accepted" ||
			entry.details.fermentV2Id !== fermentV2.id ||
			entry.details.revision !== fermentV2.revision
		) {
			continue
		}
		const draft = parseAcceptedFinalAnswerDraft(entry.content)
		if (!draft) continue
		return {
			sessionId,
			fermentV2Id: fermentV2.id,
			revision: fermentV2.revision,
			draft,
			alreadyVisible: false,
		}
	}
	return undefined
}

export function isThinkingOnlyAssistantStop(messages: readonly FermentV2Message[]): boolean {
	const message = [...messages].reverse().find((entry) => entry.role === "assistant")
	if (!message) return false
	let hasThinking = false
	for (const block of message.content) {
		if (block.type === "toolCall") return false
		if (block.type === "text" && block.text.trim()) return false
		if (block.type === "thinking") hasThinking = true
	}
	return hasThinking
}
