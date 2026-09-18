import { afterEach, describe, expect, it, vi } from "vitest"
import { trackFeedback } from "./feedback.js"
import * as telemetryIndex from "./index.js"
import { _getTelemetryCtx, _isTelemetryEnabled } from "./index.js"

vi.mock("../ferment/index.js", () => ({
	getActiveFerment: vi.fn(() => undefined),
}))

describe("trackFeedback", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		vi.restoreAllMocks()
	})

	it("re-exports from the telemetry index and exposes the enabled guard", () => {
		expect(typeof trackFeedback).toBe("function")
		expect(_isTelemetryEnabled()).toBe(false)
		expect(_getTelemetryCtx()).toBeUndefined()
	})

	it("is a no-op when telemetry is disabled", () => {
		expect(() =>
			trackFeedback({
				sentiment: "positive",
				reason: "Solved my task",
				autoModelUsed: false,
			}),
		).not.toThrow()
		expect(_getTelemetryCtx()).toBeUndefined()
	})

	it("emits feedback.rating with structured attributes when telemetry is enabled", () => {
		const emit = vi.fn()
		const fakeCtx = { emit } as unknown as { emit: ReturnType<typeof vi.fn> }
		vi.spyOn(telemetryIndex, "_isTelemetryEnabled").mockReturnValue(true)
		vi.spyOn(telemetryIndex, "_getTelemetryCtx").mockReturnValue(fakeCtx as never)

		trackFeedback({
			sentiment: "negative",
			reason: "Too slow",
			autoModelUsed: true,
		})

		expect(emit).toHaveBeenCalledWith("feedback.rating", {
			sentiment: "negative",
			reason: "Too slow",
			auto_model_used: true,
		})
	})
})
