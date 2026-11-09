/**
 * Translations for side-chat domain events (side-chat extension) into OTLP
 * records. The side-chat extension publishes lifecycle facts on the
 * pi.events bus; this module converts them into telemetry, keeping telemetry
 * decoupled from side-chat internals (same pattern as permissions /
 * bash-tool-guard / loop-guard).
 *
 * PostHog-only: these are acceptance/analytics signals (is the side chat
 * used, do users wrap up and steer the main agent with it), not inputs to
 * productivity metrics — no ClickHouse sink.
 */

import type {
	SideChatMessageSentPayload,
	SideChatStartedPayload,
	SideChatThreadCountsPayload,
} from "../../side-chat/side-chat-events.js"
import type { TelemetryAttributes, TelemetryContext } from "../session-context.js"

export const SIDE_CHAT_STARTED_EVENT = "side_chat.started"
export const SIDE_CHAT_MESSAGE_SENT_EVENT = "side_chat.message_sent"
export const SIDE_CHAT_HISTORY_REOPENED_EVENT = "side_chat.history_reopened"
export const SIDE_CHAT_WRAPPED_EVENT = "side_chat.wrapped"

/** Non-negative integer (the uint32 range the OTLP contract allows). */
function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0
}

/**
 * `quoted_selection` is optional: absent means the producer did not know
 * (attr omitted); present-but-non-boolean is out of contract and drops the
 * event.
 */
function quotedSelectionAttr(payload: { quotedSelection?: unknown }): TelemetryAttributes | undefined {
	if (payload.quotedSelection === undefined) return {}
	if (typeof payload.quotedSelection !== "boolean") return undefined
	return { quoted_selection: payload.quotedSelection }
}

/**
 * A side chat opened (`/btw` open / `/btw new`).
 *
 * Privacy: only the quote flag — never the quoted text or the opening prompt.
 */
export function handleSideChatStarted(tm: TelemetryContext, raw: unknown): void {
	const payload = raw as Partial<SideChatStartedPayload> | undefined
	if (!payload) return
	const quoted = quotedSelectionAttr(payload)
	if (!quoted) return
	tm.emit(SIDE_CHAT_STARTED_EVENT, { ...quoted, turn_index: tm.turnIndex }, undefined)
}

/**
 * A user question submitted into the side chat. `message_index` counts user
 * messages of this side chat, 1-based, this one included.
 *
 * Privacy: only the quote flag and the 1-based count — never the question.
 */
export function handleSideChatMessageSent(tm: TelemetryContext, raw: unknown): void {
	const payload = raw as Partial<SideChatMessageSentPayload> | undefined
	if (!payload || !isCount(payload.messageIndex) || payload.messageIndex < 1) return
	const quoted = quotedSelectionAttr(payload)
	if (!quoted) return
	tm.emit(
		SIDE_CHAT_MESSAGE_SENT_EVENT,
		{ ...quoted, message_index: payload.messageIndex, turn_index: tm.turnIndex },
		undefined,
	)
}

/**
 * A reopened (`side_chat.history_reopened`) or wrapped
 * (`side_chat.wrapped`) side chat: both report the user/assistant message
 * counts of the side thread the record describes.
 *
 * Privacy: only counts — never the thread's content.
 */
export function handleSideChatThreadCounts(tm: TelemetryContext, raw: unknown, eventName: string): void {
	const payload = raw as Partial<SideChatThreadCountsPayload> | undefined
	if (!isCount(payload?.messageCountUser) || !isCount(payload?.messageCountAssistant)) return
	tm.emit(
		eventName,
		{
			message_count_user: payload.messageCountUser,
			message_count_assistant: payload.messageCountAssistant,
			turn_index: tm.turnIndex,
		},
		undefined,
	)
}
