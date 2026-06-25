import { describe, expect, it } from "vitest"
import { decomposePlanToPhase, parseSharedPlan } from "./plan-decomposition.js"

describe("parseSharedPlan", () => {
	// The shared planning process produces plans with this structure:
	//   ## Goal
	//   ## Constraints
	//   ## Chunks
	//   ## Verification Strategy
	//   ## Decision Log
	//   ## Risks
	// parseSharedPlan must extract structured fields rather than splitting every
	// `##` heading into a step (which would produce steps named "Goal",
	// "Constraints", "Risks", etc.).
	const SHARED_PLAN = `## Goal
Add a caching layer to the API client so repeat requests skip the network.

## Constraints
- No new dependencies
- Preserve existing API surface
- Cache TTL must be configurable

## Chunks

### Chunk 1: Add cache primitive
- **Scope**: New \`cache.ts\` module
- **Files Changed**: src/api/cache.ts
- **Accept When**: cache.get returns undefined for missing keys; cache.set + cache.get round-trips a value

### Chunk 2: Wire cache into client
- **Scope**: API client
- **Files Changed**: src/api/client.ts
- **Accept When**: repeat GET hits the cache; cache miss falls through to network

## Verification Strategy
Run pnpm test src/api after each chunk.

## Decision Log
- Chose Map over WeakMap for predictable iteration.

## Risks
- Cache staleness: mitigated by short default TTL.
`

	it("extracts the goal from the ## Goal section", () => {
		const parsed = parseSharedPlan(SHARED_PLAN)
		expect(parsed.goal).toBe("Add a caching layer to the API client so repeat requests skip the network.")
	})

	it("extracts constraints as a list from the ## Constraints section", () => {
		const parsed = parseSharedPlan(SHARED_PLAN)
		expect(parsed.constraints).toEqual([
			"No new dependencies",
			"Preserve existing API surface",
			"Cache TTL must be configurable",
		])
	})

	it("extracts each chunk from the ## Chunks section as a step", () => {
		const parsed = parseSharedPlan(SHARED_PLAN)
		expect(parsed.chunks).toHaveLength(2)
		expect(parsed.chunks[0].title).toBe("Chunk 1: Add cache primitive")
		expect(parsed.chunks[1].title).toBe("Chunk 2: Wire cache into client")
	})

	it("derives success criteria from chunk 'Accept When' items", () => {
		const parsed = parseSharedPlan(SHARED_PLAN)
		expect(parsed.successCriteria.length).toBeGreaterThanOrEqual(2)
		expect(parsed.successCriteria.some((c) => c.includes("cache.get returns undefined for missing keys"))).toBe(true)
		expect(parsed.successCriteria.some((c) => c.includes("repeat GET hits the cache"))).toBe(true)
	})

	it("does NOT turn Verification Strategy, Decision Log, or Risks into chunks", () => {
		const parsed = parseSharedPlan(SHARED_PLAN)
		for (const chunk of parsed.chunks) {
			expect(chunk.title).not.toMatch(/^Verification Strategy/i)
			expect(chunk.title).not.toMatch(/^Decision Log/i)
			expect(chunk.title).not.toMatch(/^Risks/i)
		}
	})

	it("returns empty arrays when sections are missing", () => {
		const parsed = parseSharedPlan("Just a free-form plan with no structure.")
		expect(parsed.goal).toBe("")
		expect(parsed.constraints).toEqual([])
		expect(parsed.successCriteria).toEqual([])
		expect(parsed.chunks).toEqual([])
	})

	it("handles an empty plan gracefully", () => {
		const parsed = parseSharedPlan("")
		expect(parsed.goal).toBe("")
		expect(parsed.constraints).toEqual([])
		expect(parsed.successCriteria).toEqual([])
		expect(parsed.chunks).toEqual([])
	})
})

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
