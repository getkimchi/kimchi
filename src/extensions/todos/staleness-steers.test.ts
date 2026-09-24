import { describe, expect, it, vi } from "vitest"
import {
	closureIndicator,
	createThresholdSteerTracker,
	stalenessIndicator,
	TODO_CLOSURE_CUSTOM_TYPE,
	TODO_STALENESS_CUSTOM_TYPE,
	TODO_STALENESS_THRESHOLDS,
} from "./staleness-steers.js"

describe("stalenessIndicator", () => {
	it("returns nothing at or below the quiet band", () => {
		expect(stalenessIndicator(0)).toBeUndefined()
		expect(stalenessIndicator(8)).toBeUndefined()
	})

	it("escalates wording across the threshold bands", () => {
		expect(stalenessIndicator(9)).toContain("9 changes since last update")
		expect(stalenessIndicator(9)).toContain("refresh")
		expect(stalenessIndicator(16)).toContain("16 changes since last update")
		expect(stalenessIndicator(17)).toContain("17 changes since last update")
		expect(stalenessIndicator(17)).toContain("update")
		expect(stalenessIndicator(24)).toContain("24 changes since last update")
		expect(stalenessIndicator(25)).toContain("significantly stale")
	})

	it("suggests closing finished items in the top band (Approach C)", () => {
		const text = stalenessIndicator(25)
		expect(text).toContain("remove or complete items whose work is done")
	})
})

describe("closureIndicator", () => {
	it("lists active todos with non-directive carry-over wording", () => {
		const text = closureIndicator([{ content: "write the summary" }])
		expect(text).toContain("1 active todo")
		expect(text).toContain("- write the summary")
		expect(text).toContain("mark them completed or clear_todos")
		expect(text).toContain("carry over")
	})

	it("pluralizes for multiple active todos", () => {
		expect(closureIndicator([{ content: "a" }, { content: "b" }])).toContain("2 active todos")
	})
})

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

describe("steer custom types", () => {
	it("registers distinct custom types for staleness and closure steers", () => {
		expect(TODO_STALENESS_CUSTOM_TYPE).toBe("todo-staleness")
		expect(TODO_CLOSURE_CUSTOM_TYPE).toBe("todo-closure")
	})
})
