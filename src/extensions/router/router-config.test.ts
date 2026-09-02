import { afterEach, describe, expect, it, vi } from "vitest"
import { AUTO_MODEL_PROVIDER } from "./constants.js"
import { getRouterConfig } from "./router-config.js"

const DEFAULT_ENDPOINT = "https://llm.kimchi.dev"

function registry(apiKey: string | undefined) {
	return { getApiKeyForProvider: vi.fn().mockResolvedValue(apiKey) }
}

afterEach(() => {
	delete process.env.KIMCHI_ROUTER_ENDPOINT
})

describe("getRouterConfig", () => {
	it("reads the key for the auto-model provider and defaults the endpoint", async () => {
		const modelRegistry = registry("router-key")

		await expect(getRouterConfig(modelRegistry)).resolves.toEqual({
			endpoint: DEFAULT_ENDPOINT,
			apiKey: "router-key",
		})
		expect(modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith(AUTO_MODEL_PROVIDER)
	})

	it.each([
		["missing", undefined],
		["empty", ""],
		["whitespace-only", "   \n\t "],
	])("returns undefined for a %s key so routing never runs unauthenticated", async (_case, apiKey) => {
		await expect(getRouterConfig(registry(apiKey))).resolves.toBeUndefined()
	})

	it("trims surrounding whitespace from the key", async () => {
		await expect(getRouterConfig(registry("  router-key\n"))).resolves.toMatchObject({ apiKey: "router-key" })
	})

	it("overrides the endpoint from the environment", async () => {
		process.env.KIMCHI_ROUTER_ENDPOINT = "https://router.internal"

		await expect(getRouterConfig(registry("router-key"))).resolves.toMatchObject({
			endpoint: "https://router.internal",
		})
	})

	it.each([
		["empty", ""],
		["whitespace-only", "   "],
	])("falls back to the default endpoint for a %s override", async (_case, endpoint) => {
		process.env.KIMCHI_ROUTER_ENDPOINT = endpoint

		await expect(getRouterConfig(registry("router-key"))).resolves.toMatchObject({ endpoint: DEFAULT_ENDPOINT })
	})

	it("trims surrounding whitespace from the endpoint override", async () => {
		process.env.KIMCHI_ROUTER_ENDPOINT = "  https://router.internal  "

		await expect(getRouterConfig(registry("router-key"))).resolves.toMatchObject({
			endpoint: "https://router.internal",
		})
	})
})
