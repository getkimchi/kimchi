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
		expect(result).toBe(models[1])
	})

	it("wraps around to the start of the list", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000)]
		const result = findNextCompatibleModel(models, 1, 50_000, false)
		expect(result).toBe(models[0])
	})

	it("skips models with insufficient context window", () => {
		const models = [makeModel("small", 10_000), makeModel("big", 100_000)]
		// currentIndex = 0, currentTokens = 50_000 — "small" doesn't fit
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result).toBe(models[1])
	})

	it("skips non-vision models when hasImages is true", () => {
		const models = [makeModel("vision", 100_000, ["text", "image"]), makeModel("text-only", 100_000, ["text"])]
		const result = findNextCompatibleModel(models, 0, 50_000, true)
		expect(result).toBe(models[0])
	})

	it("returns the first non-vision model when hasImages is false", () => {
		const models = [makeModel("vision", 100_000, ["text", "image"]), makeModel("text-only", 100_000, ["text"])]
		const result = findNextCompatibleModel(models, 0, 50_000, false)
		expect(result).toBe(models[1])
	})

	it("skips both context-window-incompatible AND non-vision models", () => {
		const models = [makeModel("small-text", 10_000, ["text"]), makeModel("big-vision", 100_000, ["text", "image"])]
		// currentTokens=50_000 → "small-text" fails context check
		// hasImages=true → "small-text" also fails vision check
		const result = findNextCompatibleModel(models, 0, 50_000, true)
		expect(result).toBe(models[1])
	})

	it("returns undefined when no compatible model exists (all skipped)", () => {
		const models = [makeModel("small", 10_000), makeModel("text-only", 100_000, ["text"])]
		// 50k tokens exceeds "small"; hasImages=true blocks "text-only"
		const result = findNextCompatibleModel(models, 0, 50_000, true)
		expect(result).toBeUndefined()
	})

	it("returns undefined for an empty list", () => {
		const result = findNextCompatibleModel([], 0, null, false)
		expect(result).toBeUndefined()
	})

	it("works when currentIndex is at the last model (wraps to first)", () => {
		const models = [makeModel("a", 100_000), makeModel("b", 100_000)]
		const result = findNextCompatibleModel(models, 1, null, false)
		expect(result).toBe(models[0])
	})
})
