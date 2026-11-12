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

import type { JsonValue } from "@earendil-works/pi-ai"
import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import {
	BASH_BACKGROUND_SETTLE_MESSAGE_TYPE,
	type BashBackgroundSettleData,
} from "../../shared/bash-background-settle.js"

/** One handoff whose process exit was never recorded: its pi toolCallId and
 *  the registry handle the handoff announced. */
export interface UnsettledHandoff {
	toolCallId: string
	handle: string
}

/**
 * Handoff detection on a typed tool-result `details` payload: `handoff ===
 * true` plus a live registry handle. The shape is the extension's own
 * contract (BackgroundBashToolDetails) and details is JsonValue at the type
 * level, so the predicate — not a cast — is what recognizes the shape.
 */
function handoffHandle(details: JsonValue | undefined): string | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined
	const { handoff, handle } = details as { handoff?: JsonValue; handle?: JsonValue }
	if (handoff !== true || typeof handle !== "string" || handle.length === 0) return undefined
	return handle
}

/** toolCallId of the call a settle CustomEntry closes. Session entries are
 *  typed (CustomEntry.data is unknown), so this checks the one payload
 *  field it consumes. */
function settledToolCallId(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== BASH_BACKGROUND_SETTLE_MESSAGE_TYPE) return undefined
	const data = entry.data as BashBackgroundSettleData | undefined
	return typeof data?.toolCallId === "string" && data.toolCallId.length > 0 ? data.toolCallId : undefined
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
		const handle = handoffHandle(entry.message.details)
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
