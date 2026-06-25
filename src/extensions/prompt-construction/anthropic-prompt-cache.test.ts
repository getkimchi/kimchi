import { describe, expect, it } from "vitest"
import {
	type AnthropicCacheModel,
	supportsAnthropicPromptCache,
	toCachedSystemBlocks,
} from "./anthropic-prompt-cache.js"

const anthropic: AnthropicCacheModel = { compat: { cacheControlFormat: "anthropic" } }
const nonAnthropic: AnthropicCacheModel = {}

describe("supportsAnthropicPromptCache", () => {
	it("is true for models flagged with the anthropic cache-control format", () => {
		expect(supportsAnthropicPromptCache(anthropic)).toBe(true)
	})

	it("is false for models without the compat flag", () => {
		expect(supportsAnthropicPromptCache(nonAnthropic)).toBe(false)
		expect(supportsAnthropicPromptCache({ compat: {} })).toBe(false)
	})

	it("is false for an undefined model", () => {
		expect(supportsAnthropicPromptCache(undefined)).toBe(false)
	})
})

describe("toCachedSystemBlocks", () => {
	it("marks the static block with an ephemeral cache breakpoint for anthropic models", () => {
		expect(toCachedSystemBlocks("system prompt", anthropic)).toEqual([
			{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
		])
	})

	it("leaves the block unmarked for non-anthropic models", () => {
		expect(toCachedSystemBlocks("system prompt", nonAnthropic)).toEqual([
			{ type: "text", text: "system prompt" },
		])
	})

	it("returns no blocks for an empty prompt", () => {
		expect(toCachedSystemBlocks("", anthropic)).toEqual([])
	})
})
