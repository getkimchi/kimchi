/**
 * Transcript derivation: background handoffs with no recorded settle.
 *
 * The transcript already holds both sides of the join: the handoff fact (a
 * backgrounded bash tool RESULT recorded with `details.handoff === true` and
 * the live handle; see createBackgroundBashToolDefinition's handoff result)
 * and the settle facts (`bash-background-settle` CustomEntries, persisted
 * before the wire flip). "Which held calls never settled?" = handoffs minus
 * settles — the same derivation client's hydration runs downstream.
 *
 * The consumer is the session_start reconcile: a harness that died mid-run
 * left handoffs with no settle, and replay/hydration would restore those
 * rows as still-running forever. Settling them as failed at the next
 * session start keeps the transcript honest without any client-side
 * special case.
 *
 * Per-id FIFO, mirroring the ACP replay's consumption rule: toolCallIds get
 * recycled across a session, so a settle closes the EARLIEST still-open
 * handoff under its id, not just any handoff with that id.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { BASH_BACKGROUND_SETTLE_MESSAGE_TYPE } from "../../shared/bash-background-settle.js"

/** One handoff whose process exit was never recorded: its pi toolCallId and
 *  the registry handle the handoff announced. */
export interface UnsettledHandoff {
	toolCallId: string
	handle: string
}

/**
 * Data-shaped handoff detection, mirroring the ACP side's
 * backgroundHandoffHandle but owned here: the shape itself belongs to this
 * extension (BackgroundBashToolDetails), so the extension must not import
 * the ACP module to recognize its own contract.
 */
function handoffHandle(details: unknown): string | undefined {
	if (!details || typeof details !== "object") return undefined
	const d = details as { handoff?: unknown; handle?: unknown }
	if (d.handoff !== true || typeof d.handle !== "string" || d.handle.length === 0) return undefined
	return d.handle
}

/** ToolCallId of the call a settle CustomEntry closes, validated minimally
 *  at the trust boundary (transcripts are untrusted IO). */
function settledToolCallId(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== BASH_BACKGROUND_SETTLE_MESSAGE_TYPE) return undefined
	const data = (entry as { data?: unknown }).data
	const id = (data as { toolCallId?: unknown } | null | undefined)?.toolCallId
	return typeof id === "string" && id.length > 0 ? id : undefined
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
		if (entry.type !== "message") continue
		const m = entry.message as { role?: unknown; toolCallId?: unknown; details?: unknown } | undefined
		if (m?.role !== "toolResult" || typeof m.toolCallId !== "string") continue
		const handle = handoffHandle(m.details)
		if (handle === undefined) continue
		const remaining = openSettles.get(m.toolCallId) ?? 0
		if (remaining > 0) {
			openSettles.set(m.toolCallId, remaining - 1)
			continue
		}
		unsettled.push({ toolCallId: m.toolCallId, handle })
	}
	return unsettled
}
