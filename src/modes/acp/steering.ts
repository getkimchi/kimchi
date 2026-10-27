import type { AgentSideConnection, SessionUpdate } from "@agentclientprotocol/sdk"

import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"
import { emitExtNotification } from "./ext-notifications.js"

export type DroppedQueueReason = "cancelled" | "shutdown"

/**
 * Notify the client that queued steering messages were dropped without ever
 * being injected into the turn (e.g. session/cancel drains the queue).
 * These messages never entered session history, so they must NOT go
 * out as user_message_chunk updates — this extension notification is the
 * opt-in channel for clients that want to surface them (e.g. "3 queued
 * messages discarded"). Unaware clients ignore unknown ext notifications per
 * JSON-RPC rules.
 *
 * Fire-and-forget for the same reason as KimchiAcpAgent.send(): callers are
 * synchronous event/cancel paths, and the ACP SDK serializes outbound writes
 * on its internal queue, so ordering against surrounding sessionUpdate calls
 * is preserved without awaiting.
 */
export function notifyDroppedQueue(
	conn: AgentSideConnection,
	sessionId: string,
	droppedQueue: { steering: string[]; followUp: string[] },
	reason: DroppedQueueReason,
): void {
	if (!droppedQueue.steering.length && !droppedQueue.followUp.length) return
	emitExtNotification(conn, AVAILABLE_EXT_NOTIFICATIONS.queue_dropped, {
		sessionId,
		steering: droppedQueue.steering,
		followUp: droppedQueue.followUp,
		reason,
	})
}
/**
 * A steer whose text the handler rewrote (e.g. a `/skill:<name>` command):
 * the queue holds `rewritten`, but the client submitted (and
 * acknowledges pending steers by) `original`. FIFO — steers are consumed
 * from the front of pi's queue, so the front pair matches the next echoed
 * or dropped rewritten text.
 */
export type SteerEchoRewrite = {
	rewritten: string
	original: string
}

/**
 * Translate queued steer text back to the client's original submission for
 * surfaces that hand queue text to the client (the injected-steer echo and
 * the cancel-drain notification). Pops the front pair only when it matches
 * `text`, so unrelated queue entries pass through untouched.
 */
export function takeSteerEchoOriginal(rewrites: SteerEchoRewrite[], text: string): string {
	const front = rewrites[0]
	if (front && front.rewritten === text) {
		rewrites.shift()
		return front.original
	}
	return text
}

export function reconcileQueue(
	previous: string[],
	next: readonly string[],
): { previousQueue: string[]; sessionUpdates: SessionUpdate[] } {
	// FIFO assumption: consumed messages are removed from the front.
	// Pure-left-shift check: `next` equals `previous` shifted left by `delta`
	// → the first `delta` messages were consumed (injected into the turn).
	const delta = previous.length - next.length
	const isShift = delta >= 0 && next.every((m, i) => m === previous[i + delta])

	let consumed: string[]
	if (isShift) {
		consumed = previous.slice(0, delta)
	} else {
		// Fallback: multiset diff (handles non-FIFO reordering,
		// but can't distinguish injected vs. removed-and-requeued)
		consumed = []
		const pool = [...next]
		for (const m of previous) {
			const idx = pool.indexOf(m)
			if (idx >= 0) pool.splice(idx, 1)
			else consumed.push(m)
		}
	}

	const sessionUpdates: SessionUpdate[] = consumed.map((text) => ({
		sessionUpdate: "user_message_chunk",
		messageId: crypto.randomUUID(),
		content: { type: "text", text },
	}))

	return { previousQueue: [...next], sessionUpdates }
}
