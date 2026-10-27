/**
 * Side chat records: every side chat is referenced by a hidden custom entry
 * in the main session (latest entry per id wins), so `/side:history` can
 * list and reopen it after a restart. The record is lightweight metadata;
 * the side thread itself lives in the side chat's own file (store.ts).
 */

import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent"
import { extractText } from "../agents/prompt/context.js"
import { isSafeId, type SideThread } from "./store.js"

export const SIDE_CHAT_ENTRY_TYPE = "kimchi-side-chat"

/** Title until the first question names the side chat. */
export const UNTITLED_SIDE_CHAT = "New side chat"

const TITLE_MAX = 60

/** Persisted record of one side chat, kept in the main session. */
export interface SideChatRecord {
	id: string
	/**
	 * Main session that owns the side chat's file. A forked or resumed copy
	 * of the main session carries the record but not the ownership.
	 */
	sessionId: string
	/** Main-session leaf the side chat branched from. */
	branchLeafId: string | null
	/** Started with `/side:new`: no main-session messages inherited. */
	fresh?: boolean
	startedAt: number
	updatedAt: number
	title: string
	/** User questions asked so far, for the history list. */
	questions: number
	outcome?: "sent" | "closed"
}

/** Text of a message's `content`, which is either a string or content blocks. */
export function contentText(content: string | unknown[]): string {
	return typeof content === "string" ? content : extractText(content)
}

/**
 * System prompt of the `/wrap` session. That session sees only the side
 * thread (never the main context the side chat inherited), so the steering
 * message is built from what was decided on the side.
 */
export const WRAP_UP_SYSTEM_PROMPT = [
	"<side_chat_wrap_up>",
	"You turn a side conversation into a steering message the user will send to the main agent working on their main session.",
	"Address the main agent directly, in the second person. State the conclusions, decisions and concrete action items from the conversation, with the file paths and identifiers that matter.",
	"Skip pleasantries and do not mention the side conversation itself. Output only the message.",
	"</side_chat_wrap_up>",
].join("\n")

/** Plain-text transcript of side-thread messages: user and assistant text, plus the tools the assistant called. */
export function formatSideThread(messages: SideThread): string {
	const parts: string[] = []
	for (const message of messages) {
		if (message.role === "user") {
			const text = contentText(message.content).trim()
			if (text) parts.push(`[User]: ${text}`)
		} else if (message.role === "assistant") {
			const text = extractText(message.content).trim()
			if (text) parts.push(`[Assistant]: ${text}`)
			for (const part of message.content) {
				if (part.type === "toolCall") parts.push(`[Assistant called ${part.name}]: ${JSON.stringify(part.arguments)}`)
			}
		}
	}
	return parts.join("\n\n")
}

/** The single prompt sent to the `/wrap` session. */
export function wrapUpRequest(messages: SideThread, extra: string): string {
	return [
		`<side_conversation>\n${formatSideThread(messages)}\n</side_conversation>`,
		"Write the steering message for the main agent.",
		extra ? `Additional instructions from the user: ${extra}` : "",
	]
		.filter(Boolean)
		.join("\n\n")
}

/** Latest record per side chat id, most recently updated first; records with unsafe ids are ignored. */
export function readSideChatHistory(entries: readonly SessionEntry[]): SideChatRecord[] {
	const byId = new Map<string, SideChatRecord>()
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SIDE_CHAT_ENTRY_TYPE) continue
		const data = (entry as CustomEntry<SideChatRecord>).data
		if (isSafeId(data?.id) && isSafeId(data.sessionId)) byId.set(data.id, data)
	}
	return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

/** First non-empty line of `text` (quote markers stripped), truncated to a title. */
export function titleFrom(text: string): string {
	const line =
		text
			.split("\n")
			.map((part) => part.replace(/^>\s?/, "").trim())
			.find(Boolean) ?? UNTITLED_SIDE_CHAT
	return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

/** One `/side:history` picker row. */
export function historyLabel(record: SideChatRecord): string {
	const when = new Date(record.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
	const { questions } = record
	const fresh = record.fresh ? " · fresh" : ""
	const outcome = record.outcome === "sent" ? " · sent to main" : ""
	return `${when}  ${record.title}  (${questions} question${questions === 1 ? "" : "s"}${fresh}${outcome})`
}
