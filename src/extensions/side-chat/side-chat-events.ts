/**
 * Side-chat domain event channels published via pi.events.
 *
 * The side-chat extension emits these lifecycle facts; telemetry (and any
 * other extension) can subscribe via `pi.events.on(channel, handler)`. This
 * keeps telemetry decoupled from side-chat internals (same pattern as
 * permissions / bash-tool-guard / loop-guard).
 *
 * Privacy: payloads carry booleans and counts only. Prompts, quoted
 * transcript text, titles, and file paths are intentionally NOT emitted.
 */

export const SIDE_CHAT_EVENTS = {
	STARTED: "side-chat:started",
	MESSAGE_SENT: "side-chat:message_sent",
	HISTORY_REOPENED: "side-chat:history_reopened",
	WRAPPED: "side-chat:wrapped",
} as const

/** A side chat opened (`/btw` open / `/btw new`). */
export interface SideChatStartedPayload {
	/** The side chat was opened with a quoted transcript selection. */
	quotedSelection: boolean
}

/** A user question was submitted into the side chat. */
export interface SideChatMessageSentPayload {
	/** The submitted message carries a quoted transcript selection. */
	quotedSelection: boolean
	/** 1-based count of user messages in this side chat, this one included. */
	messageIndex: number
}

/**
 * Message counts of a side thread. `history_reopened` carries the counts of
 * the reopened thread; `wrapped` carries the counts of the thread whose
 * conclusions were enqueued to the main agent.
 */
export interface SideChatThreadCountsPayload {
	messageCountUser: number
	messageCountAssistant: number
}

export type SideChatHistoryReopenedPayload = SideChatThreadCountsPayload
export type SideChatWrappedPayload = SideChatThreadCountsPayload

/**
 * Whether a submitted side-chat message carries a quoted transcript
 * selection. Quotes are added to the editor as `> `-prefixed lines
 * (panel.addQuote), so a line in that exact form means the message carries
 * one. A bare `>` prefix is deliberately NOT matched: shell redirects
 * (`2>&1`), REPL prompts (`>>>`) or nested markdown quotes would otherwise
 * be mistaken for a quote.
 */
export function hasQuotedSelection(text: string): boolean {
	return text.split("\n").some((line) => line.startsWith("> "))
}
