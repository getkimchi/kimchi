import { describe, expect, it } from "vitest"
import { MODEL_CAPABILITIES } from "./builtin-models.js"
import type { ModelCapabilities } from "./types.js"

function capabilitiesFor(slug: string): ModelCapabilities | undefined {
	const entry = MODEL_CAPABILITIES.get(slug)
	if (!entry || entry === "ignored") return undefined
	return entry
}

describe("builtin-models — K2.7 / K3 flagship distinction", () => {
	it("K2.6 is not described as 'Flagship'", () => {
		const k26 = capabilitiesFor("kimi-k2.6")
		expect(k26).toBeDefined()
		if (!k26) return
		expect(k26.description).not.toContain("Flagship")
		expect(k26.description).toContain("High-capacity")
	})

	it("K2.7 is no longer described as 'Flagship Kimi model' — superseded by K3", () => {
		const k27 = capabilitiesFor("kimi-k2.7")
		expect(k27).toBeDefined()
		if (!k27) return
		expect(k27.description).not.toContain("Flagship Kimi model")
		expect(k27.description).toContain("Previous-generation")
	})

	it("K3 is described as 'Flagship Kimi model'", () => {
		const k3 = capabilitiesFor("kimi-k3")
		expect(k3).toBeDefined()
		if (!k3) return
		expect(k3.description).toContain("Flagship Kimi model")
	})

	it("exactly one model in the registry is described as 'Flagship Kimi model'", () => {
		const flagshipModels = [...MODEL_CAPABILITIES.entries()].filter(
			([, value]) => value !== "ignored" && value.description.includes("Flagship Kimi model"),
		)
		expect(flagshipModels).toHaveLength(1)
		expect(flagshipModels[0]?.[0]).toBe("kimi-k3")
	})

	it("K2.6 description still mentions vision support and planning use cases", () => {
		const k26 = capabilitiesFor("kimi-k2.6")
		expect(k26).toBeDefined()
		if (!k26) return
		expect(k26.description).toContain("vision support")
		expect(k26.description).toContain("planning decisions")
	})
})

describe("builtin-models — new default models", () => {
	it("kimi-k3 (orchestrator/reviewer default) is heavy-tier with vision and reasoning", () => {
		const caps = capabilitiesFor("kimi-k3")
		expect(caps).toBeDefined()
		if (!caps) return
		expect(caps.tier).toBe("heavy")
		expect(caps.vision).toBe(true)
		expect(caps.reasoning).toBe(true)
	})

	it("glm-5.3 (planner/judge default) is heavy-tier, text-only, with reasoning", () => {
		const caps = capabilitiesFor("glm-5.3")
		expect(caps).toBeDefined()
		if (!caps) return
		expect(caps.tier).toBe("heavy")
		expect(caps.vision).toBe(false)
		expect(caps.reasoning).toBe(true)
		expect(caps.description).toContain("no vision support")
	})

	it("glm-5.3-flash (builder default) is standard-tier with vision and reasoning", () => {
		const caps = capabilitiesFor("glm-5.3-flash")
		expect(caps).toBeDefined()
		if (!caps) return
		expect(caps.tier).toBe("standard")
		expect(caps.vision).toBe(true)
		expect(caps.reasoning).toBe(true)
	})

	it("deepseek-v4-flash-0731 (explorer/researcher/compactor default) is light-tier, text-only, with reasoning", () => {
		const caps = capabilitiesFor("deepseek-v4-flash-0731")
		expect(caps).toBeDefined()
		if (!caps) return
		expect(caps.tier).toBe("light")
		expect(caps.vision).toBe(false)
		expect(caps.reasoning).toBe(true)
		// Unlike the preview (reasoning: false), the official release supports
		// the low/high/max reasoning-effort ladder.
		expect(caps.description).toContain("reasoning effort")
	})
})
