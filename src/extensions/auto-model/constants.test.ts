import { describe, expect, it } from "vitest"
import {
	AUTO_MODEL_PROVIDER,
	GATED_DEFAULT_MODEL_CANDIDATES,
	isAutoRoutedModel,
	MULTI_MODEL_DEPRECATION_LABEL,
} from "./constants.js"

function model(provider: string, id: string): { provider: string; id: string } {
	return { provider, id }
}

describe("GATED_DEFAULT_MODEL_CANDIDATES", () => {
	it("tries the canonical slug before the existing extraction fallback", () => {
		// deepseek-v4-flash-0731 mirrors memory/backend.ts EXTRACTION_MODEL.
		expect(GATED_DEFAULT_MODEL_CANDIDATES).toEqual(["deepseek-v4-flash", "deepseek-v4-flash-0731"])
	})
})

describe("MULTI_MODEL_DEPRECATION_LABEL", () => {
	it("does not name Auto as the replacement", () => {
		// Organizations gated off the `auto` virtual model never see Auto, so
		// the label must not point at a model they cannot select.
		expect(MULTI_MODEL_DEPRECATION_LABEL).toBe("[Deprecated]")
	})
})

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
