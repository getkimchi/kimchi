import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { KIMCHI_DEV_PROVIDER, MODEL_CAPABILITIES } from "../orchestration/model-registry/index.js"
import { resolveClassifierModels } from "./classifier-model.js"

/** Minimal Model stub. */
function fakeModel(
	provider: string,
	id = "test-model",
	cost = { input: 10, output: 30, cacheRead: 0, cacheWrite: 0 },
): Model<Api> {
	return { provider, id, cost } as Model<Api>
}

function kimchi(id: string, cost = { input: 10, output: 30, cacheRead: 0, cacheWrite: 0 }): Model<Api> {
	return fakeModel(KIMCHI_DEV_PROVIDER, id, cost)
}

/** Registry that resolves kimchi-dev models by ID from a map, and returns a fixed available list. */
function fakeRegistry(kimchiModels: Map<string, Model<Api>> = new Map(), available: Model<Api>[] = []): ModelRegistry {
	return {
		find: (provider: string, id: string) => (provider === KIMCHI_DEV_PROVIDER ? kimchiModels.get(id) : undefined),
		getAvailable: () => available,
	} as unknown as ModelRegistry
}

const LIGHT_ID = [...MODEL_CAPABILITIES.entries()].find(([, c]) => c !== "ignored" && c.tier === "light")?.[0] ?? ""
const STANDARD_ID =
	[...MODEL_CAPABILITIES.entries()].find(([, c]) => c !== "ignored" && c.tier === "standard")?.[0] ?? ""
const HEAVY_ID = [...MODEL_CAPABILITIES.entries()].find(([, c]) => c !== "ignored" && c.tier === "heavy")?.[0] ?? ""

describe("resolveClassifierModels", () => {
	it("returns undefined when no models are available", () => {
		expect(resolveClassifierModels(fakeRegistry())).toBeUndefined()
	})

	describe("primary", () => {
		it("picks the kimchi light model regardless of current provider", () => {
			const light = kimchi(LIGHT_ID)
			const current = fakeModel("anthropic", "claude-opus")
			const registry = fakeRegistry(new Map([[LIGHT_ID, light]]), [current])

			expect(resolveClassifierModels(registry)?.primary).toBe(light)
		})

		it("falls back to standard when no light model resolves", () => {
			const standard = kimchi(STANDARD_ID)
			const current = fakeModel("anthropic", "claude-opus")
			const registry = fakeRegistry(new Map([[STANDARD_ID, standard]]), [current])

			expect(resolveClassifierModels(registry)?.primary).toBe(standard)
		})

		it("falls back to cheapest available when no kimchi models resolve", () => {
			const cheap = fakeModel("anthropic", "haiku", { input: 0.25, output: 1.25, cacheRead: 0, cacheWrite: 0 })
			const expensive = fakeModel("anthropic", "opus", { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 })
			const registry = fakeRegistry(new Map(), [cheap, expensive])

			expect(resolveClassifierModels(registry)?.primary).toBe(cheap)
		})
	})

	describe("fallback", () => {
		it("steps up to standard when light is the primary", () => {
			const light = kimchi(LIGHT_ID)
			const standard = kimchi(STANDARD_ID)
			const registry = fakeRegistry(
				new Map([
					[LIGHT_ID, light],
					[STANDARD_ID, standard],
				]),
				[light],
			)

			const result = resolveClassifierModels(registry)
			expect(result?.primary).toBe(light)
			expect(result?.fallback).toBe(standard)
		})

		it("skips to heavy when standard is unavailable", () => {
			const light = kimchi(LIGHT_ID)
			const heavy = kimchi(HEAVY_ID)
			const registry = fakeRegistry(
				new Map([
					[LIGHT_ID, light],
					[HEAVY_ID, heavy],
				]),
				[light],
			)

			const result = resolveClassifierModels(registry)
			expect(result?.primary).toBe(light)
			// If light and heavy have different IDs the fallback should be heavy.
			if (LIGHT_ID !== HEAVY_ID && STANDARD_ID !== HEAVY_ID) {
				expect(result?.fallback).toBe(heavy)
			}
		})

		it("falls back to cheapest available when no kimchi model available for fallback", () => {
			const light = kimchi(LIGHT_ID)
			const other = fakeModel("anthropic", "haiku", { input: 0.25, output: 1.25, cacheRead: 0, cacheWrite: 0 })
			const registry = fakeRegistry(new Map([[LIGHT_ID, light]]), [light, other])

			const result = resolveClassifierModels(registry)
			expect(result?.primary).toBe(light)
			expect(result?.fallback).toBe(other)
		})

		it("returns undefined fallback when no alternative exists", () => {
			const light = kimchi(LIGHT_ID)
			const registry = fakeRegistry(new Map([[LIGHT_ID, light]]), [light])

			const result = resolveClassifierModels(registry)
			expect(result?.primary).toBe(light)
			expect(result?.fallback).toBeUndefined()
		})

		it("fallback excludes primary — does not return same model twice", () => {
			const light = kimchi(LIGHT_ID)
			const registry = fakeRegistry(new Map([[LIGHT_ID, light]]), [light])

			const result = resolveClassifierModels(registry)
			expect(result?.fallback?.id).not.toBe(result?.primary?.id)
		})
	})
})
