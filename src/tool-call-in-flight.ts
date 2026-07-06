/**
 * Pure helpers for detecting an in-flight tool call in session history.
 *
 * Shared by the ferment extension (deferral scheduling: leave the pending
 * compaction in the map and retry at the next turn boundary) and the inline
 * compaction primitive in upstream-inline-compact-patch.ts (safety assertion:
 * fail loudly instead of corrupting context when a caller compacts across an
 * unpaired toolCall).
 */

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
 * Pure, total, never throws: unknown shapes are skipped defensively.
 */
export function isToolCallInFlight(messages: ReadonlyArray<unknown>): boolean {
	const callIds = new Set<string>()
	const resultIds = new Set<string>()

	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue
		const msg = raw as { role?: string; content?: unknown; toolCallId?: string }
		if (msg.role === "assistant") {
			const content = msg.content
			if (!Array.isArray(content)) continue
			for (const block of content) {
				if (!block || typeof block !== "object") continue
				const b = block as { type?: string; id?: unknown }
				if (b.type === "toolCall" && typeof b.id === "string") {
					callIds.add(b.id)
				}
			}
		} else if (msg.role === "toolResult") {
			if (typeof msg.toolCallId === "string") {
				resultIds.add(msg.toolCallId)
			}
		}
	}

	for (const id of callIds) {
		if (!resultIds.has(id)) return true
	}
	return false
}

/** Extract the message payloads from `message`-type session entries. */
export function collectMessagesFromEntries(entries: ReadonlyArray<unknown>): unknown[] {
	const messages: unknown[] = []
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue
		const e = entry as { type?: string; message?: unknown }
		if (e.type === "message" && e.message && typeof e.message === "object") {
			messages.push(e.message)
		}
	}
	return messages
}

/**
 * Like `collectMessagesFromEntries`, but scoped to entries after the newest
 * `compaction` entry. A historical orphan that predates the last compaction is
 * already neutralised at context-build time and must not permanently veto
 * every future compaction.
 */
export function collectMessagesAfterLastCompaction(entries: ReadonlyArray<unknown>): unknown[] {
	let start = 0
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]
		if (entry && typeof entry === "object" && (entry as { type?: string }).type === "compaction") {
			start = i + 1
			break
		}
	}
	return collectMessagesFromEntries(entries.slice(start))
}
