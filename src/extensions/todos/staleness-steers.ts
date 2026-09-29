import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { markHarnessSteer } from "../steer-marker.js"

/**
 * One-shot staleness steering.
 *
 * Staleness pressure used to be rendered inside the todo state block on every
 * request. That made the block content depend on volatile counters, which is
 * fine for a transient injection but breaks the persist-on-change model: the
 * persisted block must be a pure function of the todo store so it stays
 * byte-identical between real writes and can sit in the stable cache prefix.
 *
 * This module delivers the same pressure as bounded, persistent one-shot
 * steers: when a per-session counter crosses a threshold, a single hidden
 * message is sent (persisting in history at that point), and no more steers
 * fire until the epoch resets on the next relevant todo write.
 */

export const TODO_STALENESS_CUSTOM_TYPE = "todo-staleness"

/** Thresholds (post-increment count of non-todo tool calls) at which a
 *  staleness steer fires. Mirrors the old per-request indicator ranges. */
export const TODO_STALENESS_THRESHOLDS = [9, 17, 25] as const

/** Graduated staleness wording — the old `stalenessIndicator` text, moved out
 *  of the rendered block. */
export function stalenessIndicator(changes: number): string | undefined {
	if (changes <= 8) return undefined
	if (changes <= 16) return `${changes} changes since last update — refresh the list at the next natural breakpoint`
	if (changes <= 24) return `⚠ ${changes} changes since last update — update at the next natural breakpoint`
	return `⚠ ${changes} changes — list is significantly stale, update at the next natural breakpoint`
}

/** Send a hidden persistent steer message (lands in session history at the
 *  current chronological position, so it joins the stable cache prefix). */
export function sendHiddenSteer(
	pi: ExtensionAPI,
	customType: string,
	text: string,
	details: Record<string, unknown>,
): void {
	pi.sendMessage(
		{
			customType,
			display: false,
			content: markHarnessSteer(text),
			details,
		},
		{ deliverAs: "steer" },
	)
}

/**
 * Tracks which thresholds have fired for each session within the current
 * write-epoch. `reset` clears the fired set so the next epoch can fire again.
 */
export function createThresholdSteerTracker(): {
	fireCrossed(args: {
		sessionId: string
		count: number
		thresholds: readonly number[]
		send: (threshold: number) => void
	}): void
	reset(sessionId: string): void
	clear(): void
} {
	const firedBySession = new Map<string, Set<number>>()

	return {
		fireCrossed({ sessionId, count, thresholds, send }) {
			let fired = firedBySession.get(sessionId)
			if (!fired) {
				fired = new Set()
				firedBySession.set(sessionId, fired)
			}
			for (const threshold of thresholds) {
				if (count < threshold) continue
				if (fired.has(threshold)) continue
				fired.add(threshold)
				send(threshold)
			}
		},
		reset(sessionId) {
			firedBySession.delete(sessionId)
		},
		clear() {
			firedBySession.clear()
		},
	}
}
