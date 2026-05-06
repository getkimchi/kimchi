import type { Api, Model } from "@mariozechner/pi-ai"
import type { ModelRegistry } from "@mariozechner/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { KIMCHI_DEV_PROVIDER, MODEL_CAPABILITIES } from "../orchestration/model-registry/index.js"
import { resolveClassifierModel } from "./classifier-model.js"

/** Minimal Model stub — only the fields resolveClassifierModel inspects. */
function fakeModel(
	provider: string,
	id = "test-model",
	cost = { input: 10, output: 30, cacheRead: 0, cacheWrite: 0 },
): Model<Api> {
	return { provider, id, cost } as Model<Api>
}

/** Minimal ModelRegistry stub with controllable find() and getAvailable(). */
function fakeRegistry(findResult: Model<Api> | undefined = undefined, available: Model<Api>[] = []): ModelRegistry {
	return { find: () => findResult, getAvailable: () => available } as unknown as ModelRegistry
}

/** The first light-tier model ID in MODEL_CAPABILITIES. */
const LIGHT_MODEL_ID = [...MODEL_CAPABILITIES.entries()].find(
	([, caps]) => caps !== "ignored" && caps.tier === "light",
)?.[0]

describe("resolveClassifierModel", () => {
	it("returns undefined when currentModel is undefined", () => {
		expect(resolveClassifierModel(undefined, fakeRegistry())).toBeUndefined()
	})

	describe("non-kimchi-dev provider", () => {
		it("steps down two cost tiers when three cheaper models exist", () => {
			const opus = fakeModel("anthropic", "claude-opus", { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 })
			const sonnet = fakeModel("anthropic", "claude-sonnet", { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 })
			const haiku = fakeModel("anthropic", "claude-haiku", { input: 0.25, output: 1.25, cacheRead: 0, cacheWrite: 0 })
			const nano = fakeModel("anthropic", "claude-nano", { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 })

			const registry = fakeRegistry(undefined, [opus, sonnet, haiku, nano])
			const result = resolveClassifierModel(opus, registry)
			// Two steps down from opus: sonnet → haiku.
			expect(result).toBe(haiku)
		})

		it("steps down one tier when only one cheaper model exists", () => {
			const current = fakeModel("openai", "gpt-4o", { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 })
			const mini = fakeModel("openai", "gpt-4o-mini", { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 })

			const registry = fakeRegistry(undefined, [current, mini])
			const result = resolveClassifierModel(current, registry)
			expect(result).toBe(mini)
		})

		it("steps down exactly two when only two cheaper models exist", () => {
			const opus = fakeModel("anthropic", "claude-opus", { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 })
			const sonnet = fakeModel("anthropic", "claude-sonnet", { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 })
			const haiku = fakeModel("anthropic", "claude-haiku", { input: 0.25, output: 1.25, cacheRead: 0, cacheWrite: 0 })

			const registry = fakeRegistry(undefined, [opus, sonnet, haiku])
			const result = resolveClassifierModel(opus, registry)
			expect(result).toBe(haiku)
		})

		it("ignores models from other providers", () => {
			const current = fakeModel("openai", "gpt-4o", { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 })
			const cheapOther = fakeModel("anthropic", "claude-haiku", {
				input: 0.25,
				output: 1.25,
				cacheRead: 0,
				cacheWrite: 0,
			})
			const sameProvider = fakeModel("openai", "gpt-4o-mini", { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 })

			const registry = fakeRegistry(undefined, [current, cheapOther, sameProvider])
			const result = resolveClassifierModel(current, registry)
			expect(result).toBe(sameProvider)
		})

		it("picks the least expensive more-expensive model when current is already the cheapest", () => {
			const current = fakeModel("openai", "gpt-4o-mini", { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 })
			const mid = fakeModel("openai", "gpt-4o", { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 })
			const expensive = fakeModel("openai", "o3", { input: 10, output: 40, cacheRead: 0, cacheWrite: 0 })

			const registry = fakeRegistry(undefined, [current, mid, expensive])
			const result = resolveClassifierModel(current, registry)
			// Should pick gpt-4o (least expensive among more-expensive), not o3.
			expect(result).toBe(mid)
		})

		it("picks a different model even when all same-provider models cost the same", () => {
			const current = fakeModel("openai", "gpt-4o", { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 })
			const twin = fakeModel("openai", "gpt-4o-copy", { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 })

			const registry = fakeRegistry(undefined, [current, twin])
			const result = resolveClassifierModel(current, registry)
			expect(result).toBe(twin)
		})

		it("falls back to current model only when it is the sole model in the provider", () => {
			const current = fakeModel("openai", "gpt-4o")
			const registry = fakeRegistry(undefined, [current])

			const result = resolveClassifierModel(current, registry)
			expect(result).toBe(current)
		})

		it("falls back to current model when no models from the same provider are available", () => {
			const current = fakeModel("openai", "gpt-4o")
			const registry = fakeRegistry(undefined, [])

			const result = resolveClassifierModel(current, registry)
			expect(result).toBe(current)
		})

		it("does not call registry.find for a non-kimchi-dev provider", () => {
			const calls: string[] = []
			const model = fakeModel("openai", "gpt-4o")
			const registry = {
				find: (_provider: string, id: string) => {
					calls.push(id)
					return undefined
				},
				getAvailable: () => [model],
			} as unknown as ModelRegistry

			resolveClassifierModel(model, registry)
			expect(calls).toHaveLength(0)
		})
	})

	describe("kimchi-dev provider", () => {
		it("returns a light-tier model from the registry when current is not light", () => {
			const lightModel = fakeModel(KIMCHI_DEV_PROVIDER, LIGHT_MODEL_ID)
			const current = fakeModel(KIMCHI_DEV_PROVIDER, "kimi-k2.6")
			const registry = fakeRegistry(lightModel)

			const result = resolveClassifierModel(current, registry)
			expect(result).toBe(lightModel)
			expect(result?.id).toBe(LIGHT_MODEL_ID)
		})

		it("returns a different light-tier model when current is already light-tier", () => {
			const current = fakeModel(KIMCHI_DEV_PROVIDER, LIGHT_MODEL_ID)
			const otherLight = fakeModel(KIMCHI_DEV_PROVIDER, "other-light")

			// Registry returns otherLight for the light-tier ID lookup
			// We need a registry that returns different models for different IDs.
			const lightIds = [...MODEL_CAPABILITIES.entries()]
				.filter(([, caps]) => caps !== "ignored" && caps.tier === "light")
				.map(([id]) => id)

			// If there's only one light-tier in capabilities, we need to test
			// the "step up to next tier" path instead.
			if (lightIds.length <= 1) {
				// Current is the sole light-tier model. Registry should find a
				// standard-tier model as fallback.
				const standardId = [...MODEL_CAPABILITIES.entries()].find(
					([, caps]) => caps !== "ignored" && caps.tier === "standard",
				)?.[0]

				const standardModel = fakeModel(KIMCHI_DEV_PROVIDER, standardId ?? "standard-fallback")
				const registry = {
					find: (_p: string, id: string) => {
						if (id === LIGHT_MODEL_ID) return current
						if (standardId && id === standardId) return standardModel
						return undefined
					},
					getAvailable: () => [],
				} as unknown as ModelRegistry

				const result = resolveClassifierModel(current, registry)
				expect(result).not.toBe(current)
				expect(result?.id).toBe(standardModel.id)
			} else {
				// Multiple light-tier models exist — should pick the other one.
				const otherId = lightIds.find((id) => id !== LIGHT_MODEL_ID)
				const registry = {
					find: (_p: string, id: string) => {
						if (id === LIGHT_MODEL_ID) return current
						if (otherId && id === otherId) return otherLight
						return undefined
					},
					getAvailable: () => [],
				} as unknown as ModelRegistry

				const result = resolveClassifierModel(current, registry)
				expect(result).not.toBe(current)
			}
		})

		it("steps up to next tier when current is the sole light-tier model", () => {
			const current = fakeModel(KIMCHI_DEV_PROVIDER, LIGHT_MODEL_ID)
			const standardId = [...MODEL_CAPABILITIES.entries()].find(
				([, caps]) => caps !== "ignored" && caps.tier === "standard",
			)?.[0]

			const standardModel = fakeModel(KIMCHI_DEV_PROVIDER, standardId ?? "standard-fallback")
			const registry = {
				find: (_p: string, id: string) => {
					if (id === LIGHT_MODEL_ID) return current
					if (standardId && id === standardId) return standardModel
					return undefined
				},
				getAvailable: () => [],
			} as unknown as ModelRegistry

			const result = resolveClassifierModel(current, registry)
			expect(result).not.toBe(current)
		})

		it("falls back to current model only when no other models are available", () => {
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
				getAvailable: () => [],
			} as unknown as ModelRegistry

			const current = fakeModel(KIMCHI_DEV_PROVIDER, "kimi-k2.6")
			resolveClassifierModel(current, registry)

			// Should have searched for at least one light-tier model.
			expect(calls.length).toBeGreaterThan(0)
			expect(calls.every((c) => c.provider === KIMCHI_DEV_PROVIDER)).toBe(true)
			expect(calls.some((c) => c.id === LIGHT_MODEL_ID)).toBe(true)
		})
	})
})
