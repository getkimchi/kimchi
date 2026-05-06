import type { Api, Model } from "@mariozechner/pi-ai"
import type { ModelRegistry } from "@mariozechner/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { KIMCHI_DEV_PROVIDER, MODEL_CAPABILITIES } from "../orchestration/model-registry/index.js"
import { resolveClassifierModel } from "./classifier-model.js"

/** Minimal Model stub — only the fields resolveClassifierModel inspects. */
function fakeModel(provider: string, id = "test-model"): Model<Api> {
	return { provider, id } as Model<Api>
}

/** Minimal ModelRegistry stub with a controllable find(). */
function fakeRegistry(findResult: Model<Api> | undefined = undefined): ModelRegistry {
	return { find: () => findResult } as unknown as ModelRegistry
}

/** The first light-tier model ID in MODEL_CAPABILITIES. */
const LIGHT_MODEL_ID = [...MODEL_CAPABILITIES.entries()].find(
	([, caps]) => caps !== "ignored" && caps.tier === "light",
)?.[0]

describe("resolveClassifierModel", () => {
	it("returns undefined when currentModel is undefined", () => {
		expect(resolveClassifierModel(undefined, fakeRegistry())).toBeUndefined()
	})

	it("returns the current model for a non-kimchi-dev provider", () => {
		const model = fakeModel("anthropic", "claude-sonnet")
		const result = resolveClassifierModel(model, fakeRegistry())
		expect(result).toBe(model)
	})

	it("returns a light-tier model from the registry for kimchi-dev provider", () => {
		const lightModel = fakeModel(KIMCHI_DEV_PROVIDER, LIGHT_MODEL_ID)
		const current = fakeModel(KIMCHI_DEV_PROVIDER, "kimi-k2.6")
		const registry = fakeRegistry(lightModel)

		const result = resolveClassifierModel(current, registry)
		expect(result).toBe(lightModel)
		expect(result?.id).toBe(LIGHT_MODEL_ID)
	})

	it("falls back to current model when registry.find returns undefined for kimchi-dev", () => {
		const current = fakeModel(KIMCHI_DEV_PROVIDER, "kimi-k2.6")
		const registry = fakeRegistry(undefined)

		const result = resolveClassifierModel(current, registry)
		expect(result).toBe(current)
	})

	it("calls registry.find with kimchi-dev provider and a light-tier model ID", () => {
		const calls: Array<{ provider: string; id: string }> = []
		const registry = {
			find: (provider: string, id: string) => {
				calls.push({ provider, id })
				return undefined
			},
		} as unknown as ModelRegistry

		const current = fakeModel(KIMCHI_DEV_PROVIDER, "kimi-k2.6")
		resolveClassifierModel(current, registry)

		// Should have searched for at least one light-tier model.
		expect(calls.length).toBeGreaterThan(0)
		expect(calls.every((c) => c.provider === KIMCHI_DEV_PROVIDER)).toBe(true)
		expect(calls.some((c) => c.id === LIGHT_MODEL_ID)).toBe(true)
	})

	it("does not call registry.find for a non-kimchi-dev provider", () => {
		const calls: string[] = []
		const registry = {
			find: (_provider: string, id: string) => {
				calls.push(id)
				return undefined
			},
		} as unknown as ModelRegistry

		const model = fakeModel("openai", "gpt-4o")
		resolveClassifierModel(model, registry)

		expect(calls).toHaveLength(0)
	})
})
