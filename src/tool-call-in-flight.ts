/** Detect an in-flight tool call in Pi's active session messages. */

import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent"

type SessionMessage = SessionMessageEntry["message"]

/**
 * Return true if any assistant `toolCall` block `id` in `messages` has NO
 * matching `toolResult` (by `toolCallId`) anywhere in the array.
 *
 * This is the compaction-timing root-cause signal: when the trailing session
 * entries form an incomplete assistant toolCall -> toolResult pair, compacting
 * would summarise away the assistant toolCall while its toolResult is appended
 * later — creating an orphaned toolResult. By deferring compaction until the
 * pair completes, orphans are never created at the compaction boundary in the
 * first place.
 *
 */
export function isToolCallInFlight(messages: ReadonlyArray<SessionMessage>): boolean {
	const callIds = new Set<string>()
	const resultIds = new Set<string>()

	for (const message of messages) {
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
