import { describe, expect, it } from "vitest"
import { modelsForAnyStrength, modelsForStrength } from "./by-strength.js"

describe("modelsForStrength", () => {
	it("explore strength returns all explore-capable models in registry insertion order", () => {
		const result = modelsForStrength("explore")
		// Order is MODEL_CAPABILITIES insertion order — NOT a tier ranking.
		// nemotron-3-super-fp4 is currently the only model with explore strength.
		expect(result).toEqual(["kimchi-dev/nemotron-3-super-fp4"])
	})

	it("build strength returns build-capable models", () => {
		const result = modelsForStrength("build")
		expect(new Set(result)).toEqual(new Set(["kimchi-dev/nemotron-3-super-fp4", "kimchi-dev/minimax-m2.7"]))
	})

	it("review strength returns multiple kimchi-dev/* models", () => {
		const result = modelsForStrength("review")
		expect(result.length).toBeGreaterThan(1)
		for (const m of result) {
			expect(m).toMatch(/^kimchi-dev\//)
		}
	})

	it("filters to availableIds when provided", () => {
		const result = modelsForStrength("explore", { availableIds: new Set(["nemotron-3-super-fp4"]) })
		expect(result).toEqual(["kimchi-dev/nemotron-3-super-fp4"])
	})

	it("returns empty array when no model matches the strength", () => {
		const result = modelsForStrength("build", { availableIds: new Set(["kimi-k2.6"]) })
		expect(result).toEqual([])
	})

	it("result strings are always kimchi-dev/<id> format", () => {
		for (const m of modelsForStrength("plan")) {
			expect(m).toMatch(/^kimchi-dev\/.+/)
		}
	})
})

describe("modelsForAnyStrength", () => {
	it("deduplicates models that appear in multiple strengths", () => {
		const result = modelsForAnyStrength(["build", "review"])
		const unique = new Set(result)
		expect(unique.size).toBe(result.length)
	})

	it("combines build and review without duplicates", () => {
		const result = modelsForAnyStrength(["build", "review"])
		expect(new Set(result)).toEqual(
			new Set([
				"kimchi-dev/nemotron-3-super-fp4",
				"kimchi-dev/minimax-m2.7",
				"kimchi-dev/kimi-k2.6",
				"kimchi-dev/kimi-k2.5",
				"kimchi-dev/claude-opus-4-7",
			]),
		)
	})

	it("returns all models for all strengths combined, deduplicated", () => {
		const all = modelsForAnyStrength(["build", "explore", "plan", "review", "research"])
		const unique = new Set(all)
		expect(unique.size).toBe(all.length)
	})

	it("respects availableIds filter across all strengths", () => {
		const result = modelsForAnyStrength(["build", "explore"], { availableIds: new Set(["nemotron-3-super-fp4"]) })
		expect(result).toEqual(["kimchi-dev/nemotron-3-super-fp4"])
	})

	it("returns empty array when no models match any strength with the filter", () => {
		const result = modelsForAnyStrength(["build"], { availableIds: new Set(["kimi-k2.6"]) })
		expect(result).toEqual([])
	})
})
