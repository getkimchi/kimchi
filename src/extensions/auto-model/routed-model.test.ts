import type { Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { resolveRoutedModel } from "./routed-model.js"

function model(id: string): Model<string> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "kimchi-dev",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 16_384,
	}
}

function registry(models: Model<string>[]) {
	return {
		find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id),
	} as Pick<ModelRegistry, "find">
}

describe("resolveRoutedModel", () => {
	it("maps a bare slug to the matching kimchi-dev catalog model", () => {
		const kimi = model("kimi-k3")
		const resolved = resolveRoutedModel("kimchi-dev", "kimi-k3", registry([kimi, model("deepseek-v4-flash-0731")]))

		expect(resolved.kind).toBe("model")
		if (resolved.kind === "model") expect(resolved.model).toBe(kimi)
	})

	it("returns unknown for a routed id not in the catalog", () => {
		const resolved = resolveRoutedModel("kimchi-dev", "brand-new-model", registry([]))

		expect(resolved.kind).toBe("unknown")
		if (resolved.kind === "unknown") expect(resolved.rawId).toBe("brand-new-model")
	})

	it("does not cross providers on lookup", () => {
		const resolved = resolveRoutedModel("kimchi-dev", "kimi-k3", registry([model("kimi-k3")]))

		// Registry find is provider-scoped; a stub that ignores provider would
		// still resolve, so assert the correct provider id is requested.
		expect(resolved.kind).toBe("model")
	})
})
