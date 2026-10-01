/** Detect an in-flight tool call in Pi's active session messages. */

import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent"

type SessionMessage = SessionMessageEntry["message"]

/**
 * Return true if any assistant `toolCall` block `id` in the current turn's
 * messages has NO matching `toolResult` (by `toolCallId`).
 *
 * This is the compaction-timing root-cause signal: when the trailing session
 * entries form an incomplete assistant toolCall -> toolResult pair, compacting
 * would summarise away the assistant toolCall while its toolResult is appended
 * later — creating an orphaned toolResult. Deferring until the pair completes
 * prevents orphans at the compaction boundary in the first place.
 *
 * Only messages after the last user message are scanned: an unpaired toolCall
 * older than the last user message is a leftover (e.g. an aborted run) whose
 * toolResult will never arrive. Treating it as in-flight disabled compaction
 * permanently, and compacting it away is exactly what recovery wants.
 */
export function isToolCallInFlight(messages: ReadonlyArray<SessionMessage>): boolean {
	let start = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			start = i + 1
			break
		}
	}

	const callIds = new Set<string>()
	const resultIds = new Set<string>()

	for (let i = start; i < messages.length; i++) {
		const message = messages[i]
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") {
					callIds.add(block.id)
				}
			}
		} else if (message.role === "toolResult") {
			resultIds.add(message.toolCallId)
		}
	}

	for (const id of callIds) {
		if (!resultIds.has(id)) return true
	}
	return false
}
