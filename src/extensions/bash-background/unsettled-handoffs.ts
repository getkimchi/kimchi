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
 * above); an id whose settle count meets its handoff count is fully closed.
 */
export function findUnsettledHandoffs(entries: readonly SessionEntry[]): UnsettledHandoff[] {
	const openSettles = new Map<string, number>()
	for (const entry of entries) {
		const id = settledToolCallId(entry)
		if (id !== undefined) openSettles.set(id, (openSettles.get(id) ?? 0) + 1)
	}
	const unsettled: UnsettledHandoff[] = []
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue
		const handle = backgroundHandoffHandleFromDetails(entry.message.details)
		if (handle === undefined) continue
		const remaining = openSettles.get(entry.message.toolCallId) ?? 0
		if (remaining > 0) {
			openSettles.set(entry.message.toolCallId, remaining - 1)
			continue
		}
		unsettled.push({ toolCallId: entry.message.toolCallId, handle })
	}
	return unsettled
}
