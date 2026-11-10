import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyModel, ProviderHeaders } from "@earendil-works/pi-ai"
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createModel } from "../__mocks__/model-registry.js"
import { stripProviderPinningHeaders, withAutoRoutingHeaderStrip } from "./request-headers.js"

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-auto-headers-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", dir)
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(dir, { recursive: true, force: true })
})

/** The headers a kimchi-dev block stamps into every outgoing request. */
const BLOCK_HEADERS: ProviderHeaders = {
	"User-Agent": "kimchi/1.0",
	"X-Provider-Type": "ai-enabler",
	"X-Provider-Name": "ai-enabler",
	"X-CastAi-Organization-Id": "org-1",
}

/** A models.json model entry shaped like the e2e fixture's (provider blocks
 * round-trip this exact form), for loading through the real runtime. */
function modelEntry(id: string): Record<string, unknown> {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		provider: "ai-enabler",
	}
}

/**
 * A runtime whose getAuth resolves fixed block headers for any model; the
 * decorator wraps the mock, so tests can assert on the headers every
 * consumer of resolved auth (streamed requests and getApiKeyAndHeaders
 * callers alike) would put on the wire.
 */
async function decoratedAuthRuntime() {
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	})
	const getAuth = vi.fn(async (providerOrModel: string | AnyModel) => {
		if (typeof providerOrModel === "string") return { auth: { apiKey: "provider-key" } }
		return { auth: { apiKey: "model-key", headers: { ...BLOCK_HEADERS } } }
	})
	runtime.getAuth = getAuth
	await withAutoRoutingHeaderStrip(async () => runtime)()
	return { runtime, getAuth, auth: runtime.getAuth.bind(runtime) }
}

it("removes the provider-pinning headers and keeps everything else", () => {
	expect(stripProviderPinningHeaders(BLOCK_HEADERS)).toEqual({
		"User-Agent": "kimchi/1.0",
		"X-CastAi-Organization-Id": "org-1",
	})
})

it("matches pinning headers case-insensitively", () => {
	expect(stripProviderPinningHeaders({ "x-provider-type": "ai-enabler" })).toEqual({})
	expect(stripProviderPinningHeaders({ "X-Provider-NAME": "ai-enabler" })).toEqual({})
	expect(stripProviderPinningHeaders({ "x-PROVIDER-name": "ai-enabler" })).toEqual({})
})

it("preserves null values (delete-header semantics) on kept headers", () => {
	expect(stripProviderPinningHeaders({ "X-Provider-Type": "ai-enabler", "X-Custom": null })).toEqual({
		"X-Custom": null,
	})
})

it("returns an empty set for an empty input", () => {
	expect(stripProviderPinningHeaders({})).toEqual({})
})

it("resolves auto-routed model auth without the pinning headers", async () => {
	const { auth } = await decoratedAuthRuntime()
	await expect(auth(createModel("auto"))).resolves.toEqual({
		auth: { apiKey: "model-key", headers: { "User-Agent": "kimchi/1.0", "X-CastAi-Organization-Id": "org-1" } },
	})
})

it("resolves every auto* variant id without the pinning headers", async () => {
	const { auth } = await decoratedAuthRuntime()
	const resolution = await auth(createModel("auto-beta"))
	expect(resolution?.auth.headers).not.toHaveProperty("X-Provider-Type")
	expect(resolution?.auth.headers).not.toHaveProperty("X-Provider-Name")
})

it("keeps pinning headers on concrete kimchi-dev model auth", async () => {
	const { auth } = await decoratedAuthRuntime()
	await expect(auth(createModel("kimi-k3"))).resolves.toEqual({
		auth: { apiKey: "model-key", headers: { ...BLOCK_HEADERS } },
	})
})

it("keeps pinning headers on auto-prefixed ids of other providers", async () => {
	const { auth } = await decoratedAuthRuntime()
	await expect(auth(createModel("auto", "openai"))).resolves.toEqual({
		auth: { apiKey: "model-key", headers: { ...BLOCK_HEADERS } },
	})
})

it("passes provider-id auth lookups through to the original", async () => {
	const { auth, getAuth } = await decoratedAuthRuntime()
	await expect(auth("kimchi-dev")).resolves.toEqual({ auth: { apiKey: "provider-key" } })
	expect(getAuth).toHaveBeenCalledExactlyOnceWith("kimchi-dev", undefined)
})

it("forwards auth overrides to the original", async () => {
	const { auth, getAuth } = await decoratedAuthRuntime()
	const overrides = { apiKey: "override" }
	await auth(createModel("auto"), overrides)
	expect(getAuth.mock.calls[0]).toEqual([createModel("auto"), overrides])
})

it("returns resolutions without headers unchanged", async () => {
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	})
	const resolution = { auth: { apiKey: "model-key" } }
	runtime.getAuth = async () => resolution
	await withAutoRoutingHeaderStrip(async () => runtime)()
	await expect(runtime.getAuth(createModel("auto"))).resolves.toBe(resolution)
})

it("decorates a shared runtime only once", async () => {
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	})
	runtime.getAuth = async () => ({ auth: { apiKey: "model-key" } })
	await withAutoRoutingHeaderStrip(async () => runtime)()
	const decorated = runtime.getAuth
	await withAutoRoutingHeaderStrip(async () => runtime)()
	expect(runtime.getAuth).toBe(decorated)
})

it("strips the pin through the real getApiKeyAndHeaders chain", async () => {
	// No getAuth mock: a models.json block shaped like the one
	// buildModelsConfig writes is loaded by a real runtime, decorated, and
	// driven through the public API the direct callers use — pinning the
	// whole chain (config load → withConfiguredAuth → resolveConfiguredModelHeaders
	// → the strip) instead of just the wrap logic.
	const modelsPath = join(dir, "models.json")
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				"kimchi-dev": {
					baseUrl: "https://example.invalid",
					apiKey: "test-key",
					api: "openai-completions",
					authHeader: true,
					headers: { ...BLOCK_HEADERS },
					models: [modelEntry("auto"), modelEntry("routed")],
				},
			},
		}),
	)
	const runtime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath,
		refreshOnCreate: false,
		allowModelNetwork: false,
	})
	await withAutoRoutingHeaderStrip(async () => runtime)()
	const registry = new ModelRegistry(runtime)

	const auto = registry.find("kimchi-dev", "auto")
	if (!auto) throw new Error("auto model not registered")
	const autoAuth = await registry.getApiKeyAndHeaders(auto)
	if (!autoAuth.ok) throw new Error(autoAuth.error)
	// Authorization comes from the block's authHeader — proof the real auth
	// resolution ran, not just the strip wrap.
	expect(autoAuth.headers).toEqual({
		Authorization: "Bearer test-key",
		"User-Agent": "kimchi/1.0",
		"X-CastAi-Organization-Id": "org-1",
	})

	const routed = registry.find("kimchi-dev", "routed")
	if (!routed) throw new Error("routed model not registered")
	const routedAuth = await registry.getApiKeyAndHeaders(routed)
	if (!routedAuth.ok) throw new Error(routedAuth.error)
	expect(routedAuth.headers).toMatchObject({ "X-Provider-Type": "ai-enabler" })
})
