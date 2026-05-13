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

	it("does not expose a coordination store accessor", () => {
		// Regression: we deliberately removed the kanban/coordination
		// substrate. Make sure the runtime surface stays clean.
		expect("getCoord" in runtime).toBe(false)
	})
})
