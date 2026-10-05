import { describe, expect, it } from "vitest"
import { AUTO_MODEL_PROVIDER, isAutoRoutedModel } from "./constants.js"

function model(provider: string, id: string): { provider: string; id: string } {
	return { provider, id }
}

describe("isAutoRoutedModel", () => {
	it("matches auto models on the kimchi-dev provider", () => {
		// Catalog-style descriptor: provider-level runtime, no api override.
		expect(isAutoRoutedModel(model(AUTO_MODEL_PROVIDER, "auto"))).toBe(true)
	})

	it("matches auto-beta and any future auto* id on the kimchi-dev provider", () => {
		expect(isAutoRoutedModel(model(AUTO_MODEL_PROVIDER, "auto-beta"))).toBe(true)
		expect(isAutoRoutedModel(model(AUTO_MODEL_PROVIDER, "auto-next"))).toBe(true)
	})

	it("does not match concrete models or other providers", () => {
		expect(isAutoRoutedModel(model(AUTO_MODEL_PROVIDER, "kimi-k3"))).toBe(false)
		expect(isAutoRoutedModel(model("ai-enabler", "auto"))).toBe(false)
		expect(isAutoRoutedModel(model("ollama", "auto-beta"))).toBe(false)
	})

	it("treats auto* as the routing namespace by convention", () => {
		// The product contract: any kimchi-dev id starting with `auto` is a
		// backend-routed virtual model. A hypothetical concrete model must not
		// be named in that namespace.
		expect(isAutoRoutedModel(model(AUTO_MODEL_PROVIDER, "autoglm"))).toBe(true)
	})

	it("returns false for undefined", () => {
		expect(isAutoRoutedModel(undefined)).toBe(false)
	})
})
