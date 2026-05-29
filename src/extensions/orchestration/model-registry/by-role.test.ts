import { describe, expect, it } from "vitest"
import { modelsForAnyRole, modelsForRole } from "./by-role.js"

describe("modelsForRole", () => {
	it("explore role returns all explore-capable models in registry insertion order", () => {
		const result = modelsForRole("explore")
		expect(result).toEqual(["kimchi-dev/nemotron-3-super-fp4"])
	})

	it("build role returns build-capable models", () => {
		const result = modelsForRole("build")
		expect(new Set(result)).toEqual(new Set(["kimchi-dev/minimax-m2.7"]))
	})

	it("review role returns multiple kimchi-dev/* models", () => {
		const result = modelsForRole("review")
		expect(result.length).toBeGreaterThanOrEqual(1)
		for (const m of result) {
			expect(m).toMatch(/^kimchi-dev\//)
		}
	})

	it("filters to availableIds when provided", () => {
		const result = modelsForRole("explore", { availableIds: new Set(["nemotron-3-super-fp4"]) })
		expect(result).toEqual(["kimchi-dev/nemotron-3-super-fp4"])
	})

	it("returns empty array when no model matches the role", () => {
		const result = modelsForRole("build", { availableIds: new Set(["kimi-k2.6"]) })
		expect(result).toEqual([])
	})

	it("result strings are always kimchi-dev/<id> format", () => {
		for (const m of modelsForRole("plan")) {
			expect(m).toMatch(/^kimchi-dev\/.+/)
		}
	})
})

describe("modelsForAnyRole", () => {
	it("deduplicates models that appear in multiple roles", () => {
		const result = modelsForAnyRole(["build", "review"])
		const unique = new Set(result)
		expect(unique.size).toBe(result.length)
	})

	it("combines build and review without duplicates", () => {
		const result = modelsForAnyRole(["build", "review"])
		expect(new Set(result)).toEqual(new Set(["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"]))
	})

	it("returns all models for all roles combined, deduplicated", () => {
		const all = modelsForAnyRole(["build", "explore", "plan", "review", "research"])
		const unique = new Set(all)
		expect(unique.size).toBe(all.length)
	})

	it("respects availableIds filter across all roles", () => {
		const result = modelsForAnyRole(["build", "explore"], { availableIds: new Set(["nemotron-3-super-fp4"]) })
		expect(result).toEqual(["kimchi-dev/nemotron-3-super-fp4"])
	})

	it("returns empty array when no models match any role with the filter", () => {
		const result = modelsForAnyRole(["build"], { availableIds: new Set(["kimi-k2.6"]) })
		expect(result).toEqual([])
	})
})
