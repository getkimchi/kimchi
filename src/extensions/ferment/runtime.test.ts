import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDefaultFermentRuntime } from "./runtime.js"

describe("FermentRuntime", () => {
	let runtime: ReturnType<typeof createDefaultFermentRuntime>

	beforeEach(() => {
		runtime = createDefaultFermentRuntime()
		runtime.setContinuationPolicy("manual")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("does not expose a coordination store accessor", () => {
		// Regression: we deliberately removed the kanban/coordination
		// substrate. Make sure the runtime surface stays clean.
		expect("getCoord" in runtime).toBe(false)
	})

	it("defaults to manual continuation policy for interactive runtime state", () => {
		expect(runtime.getContinuationPolicy()).toBe("manual")
		expect(runtime.isAutomatedContinuationEnabled()).toBe(false)
	})

	it("sets automated continuation through helper methods", () => {
		runtime.setAutomatedContinuationEnabled(true)
		expect(runtime.getContinuationPolicy()).toBe("automated")
		expect(runtime.isAutomatedContinuationEnabled()).toBe(true)

		runtime.setAutomatedContinuationEnabled(false)
		expect(runtime.getContinuationPolicy()).toBe("manual")
		expect(runtime.isAutomatedContinuationEnabled()).toBe(false)
	})
})
