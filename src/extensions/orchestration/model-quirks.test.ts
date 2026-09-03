import { describe, expect, it } from "vitest"
import { modelHasContinuationStallQuirk } from "./model-quirks.js"

describe("modelHasContinuationStallQuirk", () => {
	it.each([
		["kimi-k2.6", true],
		["kimi-k2.7", true],
		["minimax-m3", true],
		["KIMI-K2.6", true],
		["MiniMax-M3", true],
		["kimchi-dev/kimi-k2.6", true],
		["kimchi-dev/minimax-m3", true],
		[undefined, false],
		["deepseek-v4-flash", false],
		["nemotron-3", false],
		["minimax-m2.7", false],
		["gpt-5.1", false],
		["", false],
	])("returns %s -> %s", (modelId, expected) => {
		expect(modelHasContinuationStallQuirk(modelId as string | undefined)).toBe(expected)
	})
})
