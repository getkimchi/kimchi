import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDefaultFermentRuntime } from "./runtime.js"

describe("FermentRuntime", () => {
	let runtime: ReturnType<typeof createDefaultFermentRuntime>

	beforeEach(() => {
		runtime = createDefaultFermentRuntime()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("exposes storage + state + scoping accessors", () => {
		// Sanity surface check — when we ripped out getCoord, none of the other
		// runtime contracts should have regressed.
		expect(typeof runtime.getStorage).toBe("function")
		expect(typeof runtime.getActive).toBe("function")
		expect(typeof runtime.getActiveId).toBe("function")
		expect(typeof runtime.setActive).toBe("function")
		expect(typeof runtime.markScopingInteractive).toBe("function")
		expect(typeof runtime.setPhaseStartRef).toBe("function")
		expect(typeof runtime.clearFermentState).toBe("function")
	})

	it("does not expose a coordination store accessor", () => {
		// Regression: we deliberately removed the kanban/coordination
		// substrate. Make sure the runtime surface stays clean.
		expect("getCoord" in runtime).toBe(false)
	})
})
