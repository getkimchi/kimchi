import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { markHarnessSteer } from "../steer-marker.js"

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
