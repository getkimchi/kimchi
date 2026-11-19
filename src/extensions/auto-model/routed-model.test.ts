import type { Api, Model } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { type RoutedModelRegistry, resolveRoutedModel } from "./routed-model.js"

function model(id: string, provider = "kimchi-dev"): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 16_384,
	}
}

function registry(models: Model<Api>[]): RoutedModelRegistry {
	return {
		find: (provider, id) => models.find((item) => item.provider === provider && item.id === id),
		getAll: () => models,
	}
}

describe("resolveRoutedModel", () => {
	it("maps a bare slug on the request's own provider block", () => {
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

	it("resolves a pick served by the anthropic gateway block", () => {
		const haiku = model("claude-haiku-5-5", "kimchi-dev/anthropic")
		const resolved = resolveRoutedModel("kimchi-dev", "claude-haiku-5-5", registry([haiku]))

		expect(resolved).toEqual({ kind: "model", model: haiku })
	})

	it("resolves a pick served by the openai gateway block", () => {
		const gpt = model("gpt-6-luna", "kimchi-dev/openai")
		const resolved = resolveRoutedModel("kimchi-dev", "gpt-6-luna", registry([gpt]))

		expect(resolved).toEqual({ kind: "model", model: gpt })
	})

	it("resolves any upstream block, not a fixed allowlist", () => {
		const routed = model("some-bedrock-model", "kimchi-dev/bedrock")
		const resolved = resolveRoutedModel("kimchi-dev", "some-bedrock-model", registry([routed]))

		expect(resolved).toEqual({ kind: "model", model: routed })
	})

	it("resolves the ChatGPT subscription block and the experimental block", () => {
		const codex = model("gpt-6-luna-codex", "kimchi-dev/openai-codex")
		const experimental = model("experimental-model", "kimchi-experimental")

		expect(resolveRoutedModel("kimchi-dev", codex.id, registry([codex]))).toEqual({ kind: "model", model: codex })
		expect(resolveRoutedModel("kimchi-dev", experimental.id, registry([experimental]))).toEqual({
			kind: "model",
			model: experimental,
		})
	})

	it("prefers the exact provider block when a slug exists in several blocks", () => {
		const base = model("shared-slug")
		const sibling = model("shared-slug", "kimchi-dev/anthropic")

		const resolved = resolveRoutedModel("kimchi-dev", "shared-slug", registry([base, sibling]))

		expect(resolved).toEqual({ kind: "model", model: base })
	})

	it("does not borrow a direct provider's model", () => {
		const cases = [
			model("claude-haiku-5-5", "anthropic"),
			model("gpt-6-luna", "openai"),
			model("codex-model", "openai-codex"),
			model("openrouter-model", "openrouter"),
		]

		for (const foreign of cases) {
			const resolved = resolveRoutedModel("kimchi-dev", foreign.id, registry([foreign]))
			expect(resolved).toEqual({ kind: "unknown", rawId: foreign.id })
		}
	})

	it("does not match local or dev provider blocks", () => {
		for (const provider of ["kimchi-local", "kimchi-tilt"]) {
			const local = model("llama-local", provider)
			expect(resolveRoutedModel("kimchi-dev", "llama-local", registry([local]))).toEqual({
				kind: "unknown",
				rawId: "llama-local",
			})
		}
	})

	it("queries the exact provider before scanning the catalog", () => {
		const calls: string[] = []
		const kimi = model("kimi-k3")
		const tracking: RoutedModelRegistry = {
			find: (provider, id) => {
				calls.push(`find:${provider}/${id}`)
				return provider === "kimchi-dev" && id === "kimi-k3" ? kimi : undefined
			},
			getAll: () => {
				calls.push("getAll")
				return [kimi]
			},
		}

		const resolved = resolveRoutedModel("kimchi-dev", "kimi-k3", tracking)

		expect(resolved).toEqual({ kind: "model", model: kimi })
		expect(calls).toEqual(["find:kimchi-dev/kimi-k3"])
	})
})
