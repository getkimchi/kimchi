/**
 * Side chat records: every side chat is persisted as a hidden custom entry
 * in the main session (latest entry per id wins), so `/side:history` can
 * list and reopen it after a restart.
 */

import type { AgentSession, CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent"
import { extractText } from "../agents/prompt/context.js"

export const SIDE_CHAT_ENTRY_TYPE = "kimchi-side-chat"

/** Title until the first question names the side chat. */
export const UNTITLED_SIDE_CHAT = "New side chat"

const TITLE_MAX = 60

const WRAP_UP_PREFIX = "Wrap up this side chat."

/** Persisted record of one side chat. */
export interface SideChatRecord {
	id: string
	/** Main-session leaf the side chat branched from. */
	branchLeafId: string | null
	/** Started with `/side:new`: no main-session messages inherited. */
	fresh?: boolean
	startedAt: number
	updatedAt: number
	title: string
	/** Side-thread messages only (after the inherited context). */
	messages: AgentSession["messages"]
	outcome?: "sent" | "closed"
}

/** Text of a message's `content`, which is either a string or content blocks. */
export function contentText(content: string | unknown[]): string {
	return typeof content === "string" ? content : extractText(content)
}

export function isWrapUpPrompt(text: string): boolean {
	return text.startsWith(WRAP_UP_PREFIX)
}

/** Instruction sent to the side session when the user wraps up. */
export function wrapUpPrompt(extra: string): string {
	return [
		`${WRAP_UP_PREFIX} Write a steering message the user will send to the main agent working on the main session.`,
		"Address the main agent directly, in the second person. State the conclusions, decisions and concrete action items from this side chat, with the file paths and identifiers that matter.",
		"Skip pleasantries and do not mention 'side chat' mechanics. Do not call tools. Output only the message.",
		extra ? `Additional instructions from the user: ${extra}` : "",
	]
		.filter(Boolean)
		.join("\n")
}

/** Latest record per side chat id, most recently updated first. */
export function readSideChatHistory(entries: readonly SessionEntry[]): SideChatRecord[] {
	const byId = new Map<string, SideChatRecord>()
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SIDE_CHAT_ENTRY_TYPE) continue
		const data = (entry as CustomEntry<SideChatRecord>).data
		if (data?.id) byId.set(data.id, data)
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
	const questions = record.messages.filter(
		(message) => message.role === "user" && !isWrapUpPrompt(contentText(message.content)),
	).length
	const fresh = record.fresh ? " · fresh" : ""
	const outcome = record.outcome === "sent" ? " · sent to main" : ""
	return `${when}  ${record.title}  (${questions} question${questions === 1 ? "" : "s"}${fresh}${outcome})`
}
