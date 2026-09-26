import { describe, expect, it, vi } from "vitest"
import { createThresholdSteerTracker } from "./staleness-steers.js"

const TODO_STALENESS_THRESHOLDS = [9, 17, 25]

describe("createThresholdSteerTracker", () => {
	it("fires each threshold once per epoch", () => {
		const tracker = createThresholdSteerTracker()
		const send = vi.fn()
		for (let i = 1; i <= 30; i++) {
			tracker.fireCrossed({ sessionId: "s", count: i, thresholds: TODO_STALENESS_THRESHOLDS, send })
		}
		expect(send).toHaveBeenCalledTimes(3)

		// Same count again in the same epoch: no re-fire.
		tracker.fireCrossed({ sessionId: "s", count: 30, thresholds: TODO_STALENESS_THRESHOLDS, send })
		expect(send).toHaveBeenCalledTimes(3)
	})

	it("resets the epoch per session", () => {
		const tracker = createThresholdSteerTracker()
		const send = vi.fn()
		tracker.fireCrossed({ sessionId: "s", count: 10, thresholds: TODO_STALENESS_THRESHOLDS, send })
		expect(send).toHaveBeenCalledTimes(1)
		tracker.reset("s")
		tracker.fireCrossed({ sessionId: "s", count: 10, thresholds: TODO_STALENESS_THRESHOLDS, send })
		expect(send).toHaveBeenCalledTimes(2)
	})
})
