import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AnyModel, ProviderHeaders } from "@earendil-works/pi-ai"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
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
