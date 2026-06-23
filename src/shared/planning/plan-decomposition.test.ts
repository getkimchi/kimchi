import { describe, expect, it } from "vitest"
import { decomposePlanToPhase } from "./plan-decomposition.js"

describe("decomposePlanToPhase", () => {
	describe("multi-heading plan", () => {
		it("decomposes into 3 steps", () => {
			const result = decomposePlanToPhase(
				"## Step one\nDo the first thing.\n\n## Step two\nDo the second thing.\n\n## Step three\nDo the third thing.",
			)

			expect(result.id).toBe("phase-1")
			expect(result.index).toBe(1)
			expect(result.steps).toHaveLength(3)

			expect(result.steps[0].id).toBe("step-1")
			expect(result.steps[0].index).toBe(1)
			expect(result.steps[0].description).toBe("Step one\nDo the first thing.")

			expect(result.steps[1].id).toBe("step-2")
			expect(result.steps[1].index).toBe(2)
			expect(result.steps[1].description).toBe("Step two\nDo the second thing.")

			expect(result.steps[2].id).toBe("step-3")
			expect(result.steps[2].index).toBe(3)
			expect(result.steps[2].description).toBe("Step three\nDo the third thing.")
		})

		it("derives phase name and goal from the first heading", () => {
			const result = decomposePlanToPhase(
				"## Implement feature X\nDo the thing.\n\n## Write tests\nVerify the thing works.",
			)

			expect(result.name).toBe("Implement feature X")
			expect(result.goal).toBe("Implement feature X")
		})
	})

	describe("plan with no headings", () => {
		it("returns single-step phase with full text", () => {
			const result = decomposePlanToPhase("Just do it.\nNo headings here at all.")

			expect(result.steps).toHaveLength(1)
			expect(result.steps[0].description).toBe("Just do it.\nNo headings here at all.")
			expect(result.steps[0].id).toBe("step-1")
			expect(result.steps[0].index).toBe(1)
			expect(result.id).toBe("phase-1")
			expect(result.index).toBe(1)
			expect(result.name).toBe("Just do it.")
			expect(result.goal).toBe("Just do it.")
		})
	})

	describe("plan with nested headings", () => {
		it("flattens to top-level sections only", () => {
			const result = decomposePlanToPhase(
				"## Top one\nBody of top one.\n### Sub one\nBody of sub one.\n## Top two\nBody of top two.",
			)

			expect(result.steps).toHaveLength(2)
			expect(result.steps[0].description).toBe("Top one\nBody of top one.\n### Sub one\nBody of sub one.")
			expect(result.steps[1].description).toBe("Top two\nBody of top two.")
		})
	})

	describe("empty plan", () => {
		it("returns phase with single empty step for empty string", () => {
			const result = decomposePlanToPhase("")

			expect(result.steps).toHaveLength(1)
			expect(result.steps[0].description).toBe("")
			expect(result.steps[0].id).toBe("step-1")
			expect(result.steps[0].index).toBe(1)
			expect(result.id).toBe("phase-1")
			expect(result.index).toBe(1)
			expect(result.name).toBe("")
			expect(result.goal).toBe("")
		})

		it("returns phase with single empty step for whitespace-only input", () => {
			const result = decomposePlanToPhase("   \n\t  ")

			expect(result.steps).toHaveLength(1)
			expect(result.steps[0].description).toBe("")
			expect(result.steps[0].id).toBe("step-1")
			expect(result.steps[0].index).toBe(1)
		})
	})
})
