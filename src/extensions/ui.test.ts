import { describe, expect, it } from "vitest"
import { isBareExitAlias } from "./exit-utils.js"
import { findNextCompatibleModel } from "./ui.js"

// Helper to create a minimal Model mock
function makeModel(id: string, contextWindow: number, input: string[] = ["text", "image"]) {
	return { id, provider: "test", name: id, contextWindow, input } as import("@earendil-works/pi-ai").Model<
		import("@earendil-works/pi-ai").Api
	>
}

describe("isBareExitAlias", () => {
	it("returns true for exact 'exit' input", () => {
		expect(isBareExitAlias("exit")).toBe(true)
	})

	it("returns true for 'exit' with leading/trailing whitespace", () => {
		expect(isBareExitAlias("  exit  ")).toBe(true)
		expect(isBareExitAlias("\texit\n")).toBe(true)
		expect(isBareExitAlias("  exit")).toBe(true)
		expect(isBareExitAlias("exit  ")).toBe(true)
	})

	it("returns false for '/exit' command", () => {
		expect(isBareExitAlias("/exit")).toBe(false)
	})

	it("returns false for 'EXIT' (case sensitive)", () => {
		expect(isBareExitAlias("EXIT")).toBe(false)
		expect(isBareExitAlias("Exit")).toBe(false)
	})

	it("returns false for empty input", () => {
		expect(isBareExitAlias("")).toBe(false)
		expect(isBareExitAlias("   ")).toBe(false)
	})

	it("returns false for other text", () => {
		expect(isBareExitAlias("hello")).toBe(false)
		expect(isBareExitAlias("exit now")).toBe(false)
		expect(isBareExitAlias("please exit")).toBe(false)
		expect(isBareExitAlias("quit")).toBe(false)
	})
})

describe("findNextCompatibleModel", () => {
	it("returns the next model when current is compatible", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000), makeModel("c", 100_000)]
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBe(models[1])
		expect(result.skipped).toHaveLength(0)
	})

	it("wraps around to the start of the list", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000)]
		const result = findNextCompatibleModel(models, 1, 50_000, false)
		expect(result.model).toBe(models[0])
	})

	it("skips models with insufficient context window and records reason", () => {
		const models = [makeModel("small", 10_000), makeModel("big", 100_000)]
		// currentIndex = 0, currentTokens = 50_000 — "small" doesn't fit
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBe(models[1])
		expect(result.skipped).toHaveLength(1)
		expect(result.skipped[0].model).toBe(models[0])
		expect(result.skipped[0].reason).toContain("10K context")
		expect(result.skipped[0].reason).toContain("50K tokens")
	})

	it("skips non-vision models when hasImages is true and records reason", () => {
		const models = [makeModel("vision", 100_000, ["text", "image"]), makeModel("text-only", 100_000, ["text"])]
		const result = findNextCompatibleModel(models, 0, 50_000, true)
		expect(result.model).toBe(models[0])
		expect(result.skipped).toHaveLength(1)
		expect(result.skipped[0].model).toBe(models[1])
		expect(result.skipped[0].reason).toContain("no vision support")
	})

	it("returns the first non-vision model when hasImages is false", () => {
		const models = [makeModel("vision", 100_000, ["text", "image"]), makeModel("text-only", 100_000, ["text"])]
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result.model).toBe(models[1])
		expect(result.skipped).toHaveLength(0)
	})

	it("skips both context-window-incompatible AND non-vision models", () => {
		const models = [makeModel("small-text", 10_000, ["text"]), makeModel("big-vision", 100_000, ["text", "image"])]
		// currentTokens=50_000 → "small-text" fails context check
		// hasImages=true → "small-text" also fails vision check
		const result = findNextCompatibleModel(models, 0, 50_000, true)
		expect(result.model).toBe(models[1])
		expect(result.skipped).toHaveLength(1)
	})

	it("returns undefined model when no compatible model exists (all skipped)", () => {
		const models = [makeModel("small", 10_000), makeModel("text-only", 100_000, ["text"])]
		// 50k tokens exceeds "small"; hasImages=true blocks "text-only"
		const result = findNextCompatibleModel(models, 0, 50_000, true)
		expect(result.model).toBeUndefined()
		expect(result.skipped).toHaveLength(2)
		expect(result.skipped[0].reason).toContain("context")
		expect(result.skipped[1].reason).toContain("vision")
	})

	it("returns empty skipped array for an empty list", () => {
		const result = findNextCompatibleModel([], 0, null, false)
		expect(result.model).toBeUndefined()
		expect(result.skipped).toHaveLength(0)
	})

	it("works when currentIndex is at the last model (wraps to first)", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000)]
		const result = findNextCompatibleModel(models, 1, null, false)
		expect(result.model).toBe(models[0])
	})
})
