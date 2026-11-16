/**
 * Transcript derivation: background handoffs with no recorded settle.
 *
 * The transcript already holds both sides of the join: the handoff fact (a
 * backgrounded bash tool result recorded with `details.handoff === true`
 * and the live handle) and the settle facts (`bash-background-settle`
 * CustomEntries). "Which held calls never settled?" = handoffs minus
 * settles — the same derivation client hydration runs downstream.
 *
 * Per-id FIFO, mirroring the ACP replay's consumption rule: toolCallIds get
 * recycled across a session, so a settle closes the EARLIEST still-open
 * handoff under its id, not just any handoff with that id.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import {
	BASH_BACKGROUND_SETTLE_MESSAGE_TYPE,
	backgroundHandoffHandleFromDetails,
	isBashBackgroundSettleData,
} from "../../shared/bash-background-settle.js"

/** One handoff whose process exit was never recorded: its pi toolCallId and
 *  the registry handle the handoff announced. */
export interface UnsettledHandoff {
	toolCallId: string
	handle: string
}

/** toolCallId of the call a settle CustomEntry closes — under the same
 *  strict payload guard the ACP replay consumes with (shared module): a
 *  partial/corrupt settle must not close a handoff here while replay
 *  ignores it, or the reconcile would re-settle a call the transcript
 *  already settles. */
function settledToolCallId(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== BASH_BACKGROUND_SETTLE_MESSAGE_TYPE) return undefined
	if (!isBashBackgroundSettleData(entry.data) || entry.data.toolCallId.length === 0) return undefined
	return entry.data.toolCallId
}

/**
 * Handoffs in {@link entries} with no matching settle, in transcript order.
 * Settles consume open handoffs FIFO per toolCallId (recycled-id rule
 * above), POSITIONALLY: a settle only closes the earliest open handoff
 * recorded BEFORE it, so a surplus settle under an id cannot close a
 * handoff that appears later in the transcript.
 * Handoffs carrying an empty toolCallId are ignored: no valid settle can
 * ever match one ({@link settledToolCallId} requires a non-empty id), so
 * counting them would append unresolvable settles on every reconcile.
 */
export function findUnsettledHandoffs(entries: readonly SessionEntry[]): UnsettledHandoff[] {
	const candidates: UnsettledHandoff[] = []
	const openById = new Map<string, UnsettledHandoff[]>()
	for (const entry of entries) {
		const id = settledToolCallId(entry)
		if (id !== undefined) {
			openById.get(id)?.shift()
			continue
		}
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue
		if (entry.message.toolCallId.length === 0) continue
		const handle = backgroundHandoffHandleFromDetails(entry.message.details)
		if (handle === undefined) continue
		const candidate: UnsettledHandoff = { toolCallId: entry.message.toolCallId, handle }
		candidates.push(candidate)
		const queue = openById.get(candidate.toolCallId) ?? []
		queue.push(candidate)
		openById.set(candidate.toolCallId, queue)
	}
	const open = new Set([...openById.values()].flat())
	return candidates.filter((candidate) => open.has(candidate))
}
