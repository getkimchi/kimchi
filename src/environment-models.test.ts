import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModelRegistry, ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { discoverEnvironmentModels, withEnvironmentModels } from "./environment-models.js"
import { syncKimchiAuth } from "./extensions/login/flow.js"
import { buildModelsConfig, type ModelMetadata } from "./models.js"

let dir: string
let modelsPath: string
let authPath: string
const metadata: ModelMetadata = {
	slug: "environment-model",
	display_name: "Environment Model",
	provider: "ai-enabler",
	reasoning: false,
	input_modalities: ["text"],
	is_serverless: true,
	limits: { context_window: 1000, max_output_tokens: 100 },
}

function providersFor(id: string): Record<string, ProviderConfig> {
	return buildModelsConfig([{ ...metadata, slug: id }], "https://example.invalid").providers
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-environment-models-"))
	modelsPath = join(dir, "models.json")
	authPath = join(dir, "auth.json")
	vi.stubEnv("KIMCHI_DISABLE_BUILTIN_PROVIDERS", "1")
	vi.stubEnv("KIMCHI_API_KEY", undefined)
	vi.stubEnv("KIMCHI_CODING_AGENT_DIR", dir)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
	rmSync(dir, { recursive: true, force: true })
})

it("discovers with the override and leaves the saved model cache byte-identical", async () => {
	const original = JSON.stringify({ providers: providersFor("saved-model") })
	writeFileSync(modelsPath, original)
	const fetchMock = vi.fn(async (url: string | URL | Request) =>
		Response.json(String(url).includes("/metadata") ? { models: [metadata] } : { models: [] }),
	)
	vi.stubGlobal("fetch", fetchMock)
	const discovered = await discoverEnvironmentModels(modelsPath, "environment-key", { experimental: true })
	expect(fetchMock).toHaveBeenCalledWith(
		expect.stringContaining("/metadata"),
		expect.objectContaining({ headers: { Authorization: "Bearer environment-key" } }),
	)
	expect(discovered.providers["kimchi-dev"].models?.map((model) => model.id)).toEqual(["environment-model", "auto"])
	expect(discovered.providers["kimchi-experimental"].models?.map((model) => model.id)).toEqual(["environment-model"])
	expect(readFileSync(modelsPath, "utf-8")).toBe(original)
	expect(existsSync(authPath)).toBe(false)
})

it("isolates simultaneous runtime keys and catalogs, then restores the config account on a normal launch", async () => {
	const savedProviders = providersFor("saved-model")
	const originalModels = JSON.stringify({
		providers: {
			...savedProviders,
			"kimchi-dev/old-account-only": savedProviders["kimchi-dev"],
			custom: { ...savedProviders["kimchi-dev"], apiKey: "custom-key" },
		},
	})
	const originalAuth = JSON.stringify({ "kimchi-dev": { type: "api_key", key: "config-key" } })
	writeFileSync(modelsPath, originalModels)
	writeFileSync(authPath, originalAuth)
	const create = ModelRuntime.create.bind(ModelRuntime)
	const firstProviders = providersFor("first-model")
	firstProviders["kimchi-dev/new-provider"] = firstProviders["kimchi-dev"]
	firstProviders["kimchi-experimental"] = firstProviders["kimchi-dev"]
	const [first, second] = await Promise.all([
		withEnvironmentModels(create, "first-key", firstProviders)({ authPath, modelsPath }),
		withEnvironmentModels(create, "second-key", providersFor("second-model"))({ authPath, modelsPath }),
	])
	for (const providerId of Object.keys(firstProviders)) {
		expect((await first.getAuth(providerId))?.auth.apiKey).toBe("first-key")
	}
	expect((await second.getAuth("kimchi-dev"))?.auth.apiKey).toBe("second-key")
	expect((await first.getAuth("custom"))?.auth.apiKey).toBe("custom-key")
	expect(first.getModels("kimchi-dev").map((model) => model.id)).toEqual(["first-model"])
	expect(second.getModels("kimchi-dev").map((model) => model.id)).toEqual(["second-model"])
	expect(first.getModels("kimchi-dev/old-account-only")).toEqual([])
	// The login extension adds OAuth handlers after creation; /reload refreshes the cache.
	first.registerProvider("kimchi-dev", { name: "Kimchi" })
	await first.refresh({ allowNetwork: false })
	expect((await first.getAuth("kimchi-dev"))?.auth.apiKey).toBe("first-key")
	expect(first.getModels("kimchi-dev").map((model) => model.id)).toEqual(["first-model"])
	expect(readFileSync(modelsPath, "utf-8")).toBe(originalModels)
	expect(readFileSync(authPath, "utf-8")).toBe(originalAuth)
	const normal = await create({ authPath, modelsPath, allowModelNetwork: false })
	expect((await normal.getAuth("kimchi-dev"))?.auth.apiKey).toBe("config-key")
	expect(normal.getModels("kimchi-dev").map((model) => model.id)).toEqual(["saved-model"])
	// A config-account process can refresh the shared file during our session.
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				...savedProviders,
				"kimchi-dev/added-later": savedProviders["kimchi-dev"],
			},
		}),
	)
	await first.refresh({ allowNetwork: false })
	expect(first.getModels("kimchi-dev/added-later")).toEqual([])
	expect((await first.getAuth("kimchi-dev/added-later"))?.auth.apiKey).toBe("first-key")
	expect(first.getModels("kimchi-dev").map((model) => model.id)).toEqual(["first-model"])
})

it("recovers the environment catalog on refresh after transient discovery failures without changing saved files", async () => {
	const originalModels = JSON.stringify({ providers: providersFor("saved-account-model") })
	const originalAuth = JSON.stringify({ "kimchi-dev": { type: "api_key", key: "saved-account-key" } })
	writeFileSync(modelsPath, originalModels)
	writeFileSync(authPath, originalAuth)
	let serviceAvailable = false
	const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
		if (!String(url).includes("/metadata")) return Response.json({ models: [] })
		return serviceAvailable
			? Response.json({ models: [metadata] })
			: new Response("Unavailable", { status: 503, headers: { "Retry-After": "0" } })
	})
	vi.stubGlobal("fetch", fetchMock)
	vi.spyOn(console, "warn").mockImplementation(() => {})
	const discover = () => discoverEnvironmentModels(modelsPath, "environment-key", { experimental: false })
	const initial = await discover()
	const runtime = await withEnvironmentModels(
		ModelRuntime.create.bind(ModelRuntime),
		"environment-key",
		initial.providers,
		discover,
	)({ authPath, modelsPath })
	const registry = new ModelRegistry(runtime)
	expect(registry.getAll().filter((model) => model.id !== "auto")).toEqual([])
	const startupFetches = fetchMock.mock.calls.length
	await runtime.refresh({ allowNetwork: false })
	expect(fetchMock).toHaveBeenCalledTimes(startupFetches)
	// A failed retry must leave recovery available for the next login or reload.
	await registry.refresh()
	expect(fetchMock.mock.calls.length).toBeGreaterThan(startupFetches)
	expect(registry.getAll().filter((model) => model.id !== "auto")).toEqual([])
	serviceAvailable = true
	await registry.refresh()
	expect(registry.getAvailable().map((model) => model.id)).toContain("environment-model")
	expect(registry.getAll().map((model) => model.id)).not.toContain("saved-account-model")
	expect((await runtime.getAuth("kimchi-dev"))?.auth.apiKey).toBe("environment-key")
	const metadataRequests = fetchMock.mock.calls.filter(([url]) => String(url).includes("/metadata"))
	for (const request of metadataRequests) {
		expect(request[1]).toMatchObject({ headers: { Authorization: "Bearer environment-key" } })
	}
	const recoveredFetches = fetchMock.mock.calls.length
	await registry.refresh()
	expect(fetchMock).toHaveBeenCalledTimes(recoveredFetches)
	expect(readFileSync(modelsPath, "utf-8")).toBe(originalModels)
	expect(readFileSync(authPath, "utf-8")).toBe(originalAuth)
})

it("supports an environment-only first launch without saving credentials or a model cache", async () => {
	const runtime = await withEnvironmentModels(
		ModelRuntime.create.bind(ModelRuntime),
		"environment-key",
		providersFor("first-model"),
	)({ authPath, modelsPath })
	expect((await runtime.getAuth("kimchi-dev"))?.auth.apiKey).toBe("environment-key")
	expect((await runtime.getAvailable("kimchi-dev")).map((model) => model.id)).toEqual(["first-model"])
	// Pi may initialize an empty credential store while checking availability.
	expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({})
	expect(existsSync(modelsPath)).toBe(false)
})

it("explicit login saves the new config credential while retaining the environment override", async () => {
	writeFileSync(modelsPath, JSON.stringify({ providers: providersFor("saved-model") }))
	vi.stubEnv("KIMCHI_API_KEY", "environment-key")
	const runtime = await withEnvironmentModels(
		ModelRuntime.create.bind(ModelRuntime),
		"environment-key",
		providersFor("environment-model"),
	)({ authPath, modelsPath })
	await syncKimchiAuth(new ModelRegistry(runtime), "new-config-key")
	expect(JSON.parse(readFileSync(authPath, "utf-8"))["kimchi-dev"].key).toBe("new-config-key")
	expect((await runtime.getAuth("kimchi-dev"))?.auth.apiKey).toBe("environment-key")
})
