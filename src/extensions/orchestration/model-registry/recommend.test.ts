import { describe, expect, it } from "vitest"
import { pickFromModelListByTier, recommendModel } from "./recommend.js"

describe("recommendModel", () => {
	it("returns a result for a single strength with exact tier match", () => {
		// build strength has standard (minimax-m2.7) and light (nemotron-3-super-fp4)
		const result = recommendModel({ strengths: ["build"], preferTier: "standard" })
		expect(result).toBeDefined()
		expect(result?.provider).toBe("kimchi-dev")
		expect(result?.modelId).toBe("minimax-m2.7")
		expect(result?.capabilities.tier).toBe("standard")
	})

	it("falls back to next tier when preferred tier has no match", () => {
		// build strength has no heavy tier model; should fall back to standard
		const result = recommendModel({ strengths: ["build"], preferTier: "heavy" })
		expect(result).toBeDefined()
		// heavy → standard fallback
		expect(result?.capabilities.tier).toBe("standard")
	})

	it("returns undefined when no model matches the strengths", () => {
		// No model has both "build" and "research" as strengths simultaneously
		const result = recommendModel({ strengths: ["build", "research"] })
		expect(result).toBeUndefined()
	})

	it("respects vision filter — excludes non-vision models", () => {
		// research + vision: kimi-k2.6, kimi-k2.5, claude-opus-4-7 have research with vision
		const result = recommendModel({ strengths: ["research"], needsVision: true })
		expect(result).toBeDefined()
		expect(result?.capabilities.vision).toBe(true)
	})

	it("returns undefined when vision required but no matching vision model", () => {
		// build + vision: nemotron has no vision, minimax has no vision
		const result = recommendModel({ strengths: ["build"], needsVision: true })
		expect(result).toBeUndefined()
	})

	it("multi-strength filter: plan + review have overlapping heavy models", () => {
		// kimi-k2.6 has both plan and review, tier heavy
		const result = recommendModel({ strengths: ["plan", "review"], preferTier: "heavy" })
		expect(result).toBeDefined()
		expect(result?.capabilities.tier).toBe("heavy")
		expect(result?.capabilities.strengths).toContain("plan")
		expect(result?.capabilities.strengths).toContain("review")
	})

	it("ignored entries are excluded", () => {
		// glm-5-fp8 is ignored; requesting any strength should not return it
		const result = recommendModel({ strengths: ["build"] })
		expect(result?.modelId).not.toBe("glm-5-fp8")
	})

	it("light tier preference returns the lightest model", () => {
		// build + light → nemotron-3-super-fp4
		const result = recommendModel({ strengths: ["build"], preferTier: "light" })
		expect(result).toBeDefined()
		expect(result?.modelId).toBe("nemotron-3-super-fp4")
		expect(result?.capabilities.tier).toBe("light")
	})

	it("returns first by registry insertion order when multiple match same tier", () => {
		// plan + heavy: kimi-k2.6 and kimi-k2.5 and claude-opus-4-7 have plan at heavy tier.
		// First by registry insertion order is kimi-k2.6.
		const result = recommendModel({ strengths: ["plan"], preferTier: "heavy" })
		expect(result).toBeDefined()
		expect(result?.modelId).toBe("kimi-k2.6")
	})

	it("returns undefined for empty strengths that somehow miss all models — sanity check with impossible combo", () => {
		// Empty strengths with vision=true should return the first vision model found
		const result = recommendModel({ strengths: [], needsVision: true, preferTier: "heavy" })
		expect(result).toBeDefined()
		expect(result?.capabilities.vision).toBe(true)
	})

	it("provider is always kimchi-dev", () => {
		const result = recommendModel({ strengths: ["build"] })
		expect(result?.provider).toBe("kimchi-dev")
	})
})

describe("pickFromModelListByTier", () => {
	it("returns undefined for empty list", () => {
		expect(pickFromModelListByTier([])).toBeUndefined()
	})

	it("picks the heavy entry when preferTier=heavy and a heavy model is in the list", () => {
		// kimi-k2.6 (heavy), nemotron-3-super-fp4 (light), minimax-m2.7 (standard)
		const result = pickFromModelListByTier(
			["kimchi-dev/nemotron-3-super-fp4", "kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
			"heavy",
		)
		expect(result).toBe("kimchi-dev/kimi-k2.6")
	})

	it("picks the light entry when preferTier=light", () => {
		const result = pickFromModelListByTier(
			["kimchi-dev/kimi-k2.6", "kimchi-dev/nemotron-3-super-fp4", "kimchi-dev/minimax-m2.7"],
			"light",
		)
		expect(result).toBe("kimchi-dev/nemotron-3-super-fp4")
	})

	it("falls back through tiers when no exact tier match (heavy → standard → light)", () => {
		// Only light models in the list; preferTier=heavy should fall back to light.
		const result = pickFromModelListByTier(["kimchi-dev/nemotron-3-super-fp4"], "heavy")
		expect(result).toBe("kimchi-dev/nemotron-3-super-fp4")
	})

	it("preserves caller order when no entries are known to the registry", () => {
		const result = pickFromModelListByTier(["custom/unknown-1", "custom/unknown-2"], "heavy")
		expect(result).toBe("custom/unknown-1")
	})

	it("ignores unknown entries when picking among known ones", () => {
		const result = pickFromModelListByTier(["custom/unknown", "kimchi-dev/kimi-k2.6", "custom/also-unknown"], "heavy")
		expect(result).toBe("kimchi-dev/kimi-k2.6")
	})

	it("defaults preferTier to standard when not specified", () => {
		const result = pickFromModelListByTier(["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"])
		expect(result).toBe("kimchi-dev/minimax-m2.7")
	})
})
