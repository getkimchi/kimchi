import { describe, expect, it } from "vitest"
import { MODEL_CAPABILITIES } from "./builtin-models.js"

describe("builtin-models — K2.6 / K2.7 flagship distinction", () => {
	it("K2.6 is not described as 'Flagship'", () => {
		const k26 = MODEL_CAPABILITIES.get("kimi-k2.6")
		expect(k26).toBeDefined()
		expect(k26).not.toBe("ignored")
		if (!k26 || k26 === "ignored") return
		expect(k26.description).not.toContain("Flagship")
		expect(k26.description).toContain("High-capacity")
	})

	it("K2.7 is described as 'Flagship Kimi model'", () => {
		const k27 = MODEL_CAPABILITIES.get("kimi-k2.7")
		expect(k27).toBeDefined()
		expect(k27).not.toBe("ignored")
		if (!k27 || k27 === "ignored") return
		expect(k27.description).toContain("Flagship Kimi model")
	})

	it("exactly one model in the registry is described as 'Flagship Kimi model'", () => {
		const flagshipModels = [...MODEL_CAPABILITIES.entries()].filter(
			([, value]) => value !== "ignored" && value.description.includes("Flagship Kimi model"),
		)
		expect(flagshipModels).toHaveLength(1)
		expect(flagshipModels[0]?.[0]).toBe("kimi-k2.7")
	})

	it("K2.6 description still mentions vision support and planning use cases", () => {
		const k26 = MODEL_CAPABILITIES.get("kimi-k2.6")
		expect(k26).toBeDefined()
		expect(k26).not.toBe("ignored")
		if (!k26 || k26 === "ignored") return
		expect(k26.description).toContain("vision support")
		expect(k26.description).toContain("planning decisions")
	})
})
