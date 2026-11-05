import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { withExperimentalFeatures } from "./extensions/experimental.js"

// The global config path is fixed from homedir() at import time.
const home = await vi.hoisted(async () => {
	const fs = await import("node:fs")
	const os = await import("node:os")
	const path = await import("node:path")
	return fs.mkdtempSync(path.join(os.tmpdir(), "kimchi-resolve-endpoints-home-"))
})

vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>()
	return { ...actual, homedir: () => home }
})

const { endpointsForRegion, invalidateResolvedEndpoints, resolveEndpoints, writeApiKey } = await import("./config.js")
// The legacy-layout endpoints (path-prefixed bases) a discovery document
// may advertise — the derivation helpers must append shapes onto these too.
const LEGACY_LAYOUT = {
	api: "https://kimchi.example.com/api",
	console: "https://kimchi.example.com",
	llm: "https://kimchi.example.com/llm",
}

const configPath = join(home, ".config", "kimchi", "config.json")

describe("resolveEndpoints (default config path)", () => {
	let cwd: string

	beforeEach(() => {
		mkdirSync(join(home, ".config", "kimchi"), { recursive: true })
		cwd = mkdtempSync(join(home, "cwd-"))
		vi.spyOn(process, "cwd").mockReturnValue(cwd)
		vi.stubEnv("KIMCHI_REGION", undefined)
		vi.stubEnv("KIMCHI_WEB_APP_URL", undefined)
		vi.stubEnv("KIMCHI_REMOTE_ENDPOINT", undefined)
		vi.stubEnv("KIMCHI_BASE_URL", undefined)
		invalidateResolvedEndpoints()
	})

	afterAll(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		rmSync(home, { recursive: true, force: true })
	})

	it("picks up a region written to the config file by another process", () => {
		writeFileSync(configPath, JSON.stringify({ region: "us" }))
		expect(resolveEndpoints().webAppUrl).toBe("https://app.kimchi.dev")

		// Out-of-process write, no in-process invalidation.
		writeFileSync(configPath, JSON.stringify({ region: "eu", apiKey: "k" }))

		const resolved = resolveEndpoints()
		expect(resolved.region).toBe("eu")
		expect(resolved.webAppUrl).toBe("https://app.eu.kimchi.dev")
		expect(resolved.castApiUrl).toBe("https://api.eu.cast.ai")
	})

	it("picks up a KIMCHI_REGION change without a config write", () => {
		writeFileSync(configPath, JSON.stringify({ region: "us" }))
		expect(resolveEndpoints().region).toBe("us")

		vi.stubEnv("KIMCHI_REGION", "eu")
		expect(resolveEndpoints().region).toBe("eu")
	})

	it("KIMCHI_BASE_URL overrides every llmBaseUrl-derived endpoint without a config write", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "k", region: "us", llmEndpoint: "https://custom.example/v1" }))
		expect(resolveEndpoints().llmBaseUrl).toBe("https://llm.kimchi.dev")
		expect(resolveEndpoints().llmEndpoint).toBe("https://custom.example/v1")

		vi.stubEnv("KIMCHI_BASE_URL", "https://env.example")
		const resolved = resolveEndpoints()
		expect(resolved.llmBaseUrl).toBe("https://env.example")
		expect(resolved.openAiBaseUrl).toBe("https://env.example/openai/v1")
		expect(resolved.anthropicBaseUrl).toBe("https://env.example/anthropic")
		expect(resolved.searchUrl).toBe("https://env.example/v1/search")
		expect(resolved.experimentalOpenAiBaseUrl).toBe("https://env.example/experimental/openai/v1")
		expect(resolved.llmEndpoint).toBe("https://env.example/openai/v1")

		vi.stubEnv("KIMCHI_BASE_URL", undefined)
		expect(resolveEndpoints().llmBaseUrl).toBe("https://llm.kimchi.dev")
		expect(resolveEndpoints().llmEndpoint).toBe("https://custom.example/v1")
	})

	it("KIMCHI_BASE_URL overrides the region default llmBaseUrl", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "k", region: "eu" }))
		expect(resolveEndpoints().llmBaseUrl).toBe("https://llm.eu.kimchi.dev")

		vi.stubEnv("KIMCHI_BASE_URL", "https://env.example")
		expect(resolveEndpoints().llmBaseUrl).toBe("https://env.example")
		expect(resolveEndpoints().llmEndpoint).toBe("https://env.example/openai/v1")
	})
})

describe("resolveEndpoints — self-hosted region", () => {
	let cwd: string

	beforeEach(() => {
		mkdirSync(join(home, ".config", "kimchi"), { recursive: true })
		cwd = mkdtempSync(join(home, "cwd-"))
		vi.spyOn(process, "cwd").mockReturnValue(cwd)
		vi.stubEnv("KIMCHI_REGION", undefined)
		vi.stubEnv("KIMCHI_WEB_APP_URL", undefined)
		vi.stubEnv("KIMCHI_REMOTE_ENDPOINT", undefined)
		vi.stubEnv("KIMCHI_BASE_URL", undefined)
		invalidateResolvedEndpoints()
	})

	afterAll(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		rmSync(home, { recursive: true, force: true })
	})

	it("derives every endpoint from the stored base-derived endpoints", () => {
		writeFileSync(
			configPath,
			JSON.stringify({ apiKey: "k", region: "self-hosted", selfHostedEndpoints: LEGACY_LAYOUT }),
		)

		const resolved = resolveEndpoints()
		expect(resolved).toMatchObject({
			region: "self-hosted",
			webAppUrl: "https://kimchi.example.com",
			platformApiUrl: "https://kimchi.example.com/api",
			llmBaseUrl: "https://kimchi.example.com/llm",
			openAiBaseUrl: "https://kimchi.example.com/llm/openai/v1",
			anthropicBaseUrl: "https://kimchi.example.com/llm/anthropic",
			experimentalOpenAiBaseUrl: "https://kimchi.example.com/llm/experimental/openai/v1",
			searchUrl: "https://kimchi.example.com/llm/v1/search",
			castApiUrl: "https://kimchi.example.com/api",
			keyValidationUrl: "https://kimchi.example.com/api/v1/llm/openai/supported-providers",
			telemetryLogsUrl: "https://kimchi.example.com/api/ai-optimizer/v1beta/logs:ingest",
			telemetryMetricsUrl: "https://kimchi.example.com/api/ai-optimizer/v1beta/metrics:ingest",
			// llmEndpoint follows the region's derived gateway, not a stored custom value.
			llmEndpoint: "https://kimchi.example.com/llm/openai/v1",
		})
	})

	it("normalizes trailing slashes in the stored endpoints", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				region: "self-hosted",
				selfHostedEndpoints: {
					api: "https://kimchi.example.com/api",
					console: "https://kimchi.example.com/",
					llm: "https://kimchi.example.com/llm",
				},
			}),
		)

		expect(resolveEndpoints().llmBaseUrl).toBe("https://kimchi.example.com/llm")
		expect(resolveEndpoints().webAppUrl).toBe("https://kimchi.example.com")
		expect(resolveEndpoints().castApiUrl).toBe("https://kimchi.example.com/api")
	})

	it("treats invalid stored endpoints as unset and fails fast", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				region: "self-hosted",
				selfHostedEndpoints: {
					api: "https://kimchi.example.com/api",
					console: "not a url",
					llm: "https://kimchi.example.com/llm",
				},
			}),
		)

		expect(() => resolveEndpoints()).toThrow(/self-hosted.*console URL/s)
	})

	it("KIMCHI_REGION=self-hosted resolves without the config-file region", () => {
		writeFileSync(configPath, JSON.stringify({ region: "us", selfHostedEndpoints: LEGACY_LAYOUT }))
		expect(resolveEndpoints().region).toBe("us")

		vi.stubEnv("KIMCHI_REGION", "self-hosted")
		const resolved = resolveEndpoints()
		expect(resolved.region).toBe("self-hosted")
		expect(resolved.webAppUrl).toBe("https://kimchi.example.com")
	})

	it("KIMCHI_BASE_URL still overrides the gateway on top of the base URL", () => {
		writeFileSync(configPath, JSON.stringify({ region: "self-hosted", selfHostedEndpoints: LEGACY_LAYOUT }))

		vi.stubEnv("KIMCHI_BASE_URL", "https://gateway.example")
		const resolved = resolveEndpoints()
		expect(resolved.llmBaseUrl).toBe("https://gateway.example")
		expect(resolved.openAiBaseUrl).toBe("https://gateway.example/openai/v1")
		expect(resolved.llmEndpoint).toBe("https://gateway.example/openai/v1")
		// Non-gateway endpoints keep deriving from the self-hosted base.
		expect(resolved.webAppUrl).toBe("https://kimchi.example.com")
		expect(resolved.castApiUrl).toBe("https://kimchi.example.com/api")
	})

	it("fails fast with an actionable error when no console URL is configured", () => {
		writeFileSync(configPath, JSON.stringify({ region: "self-hosted" }))

		// The actionable error names the fix instead of silently falling
		// back to another region's endpoints.
		expect(() => resolveEndpoints()).toThrow(/kimchi login/)
	})

	it("endpointsForRegion fails fast for self-hosted without endpoints", () => {
		writeFileSync(configPath, JSON.stringify({ region: "us" }))

		expect(() => endpointsForRegion("self-hosted")).toThrow(/console URL is configured/)
	})

	it("resolves a stored self-hosted region without the experimental flag", async () => {
		// The gate is selection-only: resolveEndpoints never consults the flag.
		writeFileSync(configPath, JSON.stringify({ region: "self-hosted", selfHostedEndpoints: LEGACY_LAYOUT }))

		await withExperimentalFeatures(false, () => {
			expect(resolveEndpoints().webAppUrl).toBe("https://kimchi.example.com")
		})
	})

	it("picks up selfHostedEndpoints written to the config file by another process", () => {
		writeFileSync(configPath, JSON.stringify({ region: "self-hosted" }))
		expect(() => resolveEndpoints()).toThrow(/console URL is configured/)

		// Out-of-process write, no in-process invalidation.
		writeFileSync(
			configPath,
			JSON.stringify({
				region: "self-hosted",
				selfHostedEndpoints: {
					api: "https://late.example.com/api",
					console: "https://late.example.com",
					llm: "https://late.example.com/llm",
				},
			}),
		)
		expect(resolveEndpoints().webAppUrl).toBe("https://late.example.com")
	})
})

describe("resolveEndpoints — self-hosted discovery endpoints", () => {
	let cwd: string

	beforeEach(() => {
		mkdirSync(join(home, ".config", "kimchi"), { recursive: true })
		cwd = mkdtempSync(join(home, "cwd-"))
		vi.spyOn(process, "cwd").mockReturnValue(cwd)
		vi.stubEnv("KIMCHI_REGION", undefined)
		vi.stubEnv("KIMCHI_WEB_APP_URL", undefined)
		vi.stubEnv("KIMCHI_REMOTE_ENDPOINT", undefined)
		vi.stubEnv("KIMCHI_BASE_URL", undefined)
		invalidateResolvedEndpoints()
	})

	afterAll(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		rmSync(home, { recursive: true, force: true })
	})

	it("resolves every endpoint from stored discovery endpoints (llm origin-only rule)", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				apiKey: "k",
				region: "self-hosted",
				selfHostedEndpoints: {
					api: "https://kimchi.example.com",
					console: "https://kimchi.example.com",
					llm: "https://llm.example.com",
				},
			}),
		)

		const resolved = resolveEndpoints()
		expect(resolved).toMatchObject({
			region: "self-hosted",
			webAppUrl: "https://kimchi.example.com",
			// The platform API is the api origin directly (alias of castApiUrl) —
			// the console host carries no API traffic.
			platformApiUrl: "https://kimchi.example.com",
			llmBaseUrl: "https://llm.example.com",
			// The llm value is the ORIGIN ONLY — consumers append the API shape.
			openAiBaseUrl: "https://llm.example.com/openai/v1",
			anthropicBaseUrl: "https://llm.example.com/anthropic",
			experimentalOpenAiBaseUrl: "https://llm.example.com/experimental/openai/v1",
			searchUrl: "https://llm.example.com/v1/search",
			// REST API paths live at the root of the advertised api origin.
			castApiUrl: "https://kimchi.example.com",
			keyValidationUrl: "https://kimchi.example.com/v1/llm/openai/supported-providers",
			telemetryLogsUrl: "https://kimchi.example.com/ai-optimizer/v1beta/logs:ingest",
			telemetryMetricsUrl: "https://kimchi.example.com/ai-optimizer/v1beta/metrics:ingest",
			llmEndpoint: "https://llm.example.com/openai/v1",
		})
	})

	it("discovery endpoints replace previously stored different ones", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				region: "self-hosted",
				selfHostedEndpoints: {
					api: "https://api.other.example.com",
					console: "https://console.other.example.com",
					llm: "https://llm.other.example.com",
				},
			}),
		)

		const resolved = resolveEndpoints()
		expect(resolved.webAppUrl).toBe("https://console.other.example.com")
		expect(resolved.castApiUrl).toBe("https://api.other.example.com")
		expect(resolved.llmBaseUrl).toBe("https://llm.other.example.com")
	})

	it("treats invalid stored endpoints as unset and fails fast", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				region: "self-hosted",
				selfHostedEndpoints: {
					api: "https://kimchi.example.com",
					console: "https://kimchi.example.com",
					llm: "not a url",
				},
			}),
		)

		expect(() => resolveEndpoints()).toThrow(/console URL is configured/)
	})

	it("KIMCHI_BASE_URL still overrides the discovered gateway", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				region: "self-hosted",
				selfHostedEndpoints: {
					api: "https://kimchi.example.com",
					console: "https://kimchi.example.com",
					llm: "https://llm.example.com",
				},
			}),
		)

		vi.stubEnv("KIMCHI_BASE_URL", "https://gateway.example")
		const resolved = resolveEndpoints()
		expect(resolved.llmBaseUrl).toBe("https://gateway.example")
		expect(resolved.openAiBaseUrl).toBe("https://gateway.example/openai/v1")
		expect(resolved.webAppUrl).toBe("https://kimchi.example.com")
		expect(resolved.castApiUrl).toBe("https://kimchi.example.com")
	})

	it("endpointsForRegion: fresh endpoints beat the stored ones", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				region: "self-hosted",
				selfHostedEndpoints: {
					api: "https://stored.example.com/api",
					console: "https://stored.example.com",
					llm: "https://stored.example.com/llm",
				},
			}),
		)

		const resolved = endpointsForRegion("self-hosted", {
			endpoints: {
				api: "https://kimchi.example.com",
				console: "https://kimchi.example.com",
				llm: "https://llm.example.com",
			},
		})
		expect(resolved.webAppUrl).toBe("https://kimchi.example.com")
		expect(resolved.llmBaseUrl).toBe("https://llm.example.com")
		expect(resolved.openAiBaseUrl).toBe("https://llm.example.com/openai/v1")
	})

	it("writeApiKey persists discovery endpoints, and a re-login replaces them with the new install's", () => {
		const first = {
			api: "https://kimchi.example.com",
			console: "https://kimchi.example.com",
			llm: "https://llm.example.com",
		}

		// First login: region + the document's endpoints stored.
		writeApiKey("k1", configPath, { region: "self-hosted", selfHostedEndpoints: first })
		expect(resolveEndpoints().llmBaseUrl).toBe("https://llm.example.com")
		expect(resolveEndpoints().openAiBaseUrl).toBe("https://llm.example.com/openai/v1")

		// Re-login against a different install: the endpoints are REPLACED.
		writeApiKey("k2", configPath, {
			region: "self-hosted",
			selfHostedEndpoints: {
				api: "https://other.example.com",
				console: "https://other.example.com",
				llm: "https://llm.other.example.com",
			},
		})
		expect(resolveEndpoints().llmBaseUrl).toBe("https://llm.other.example.com")
		expect(resolveEndpoints().openAiBaseUrl).toBe("https://llm.other.example.com/openai/v1")
	})

	it("keeps stored discovery endpoints when switching away and back to self-hosted", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				apiKey: "k",
				region: "self-hosted",
				selfHostedEndpoints: {
					api: "https://kimchi.example.com",
					console: "https://kimchi.example.com",
					llm: "https://llm.example.com",
				},
			}),
		)

		// Switching away leaves the self-hosted config stored (same semantics
		// as the endpoints' account-level peers); switching back resolves the
		// discovered endpoints.
		writeApiKey("us-token", configPath, { region: "us", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		expect(resolveEndpoints().region).toBe("us")

		writeApiKey("self-hosted-token", configPath, { region: "self-hosted" })
		expect(resolveEndpoints().llmBaseUrl).toBe("https://llm.example.com")
	})
})

describe("resolveEndpoints — self-hosted region round-trip", () => {
	let cwd: string

	beforeEach(() => {
		mkdirSync(join(home, ".config", "kimchi"), { recursive: true })
		cwd = mkdtempSync(join(home, "cwd-"))
		vi.spyOn(process, "cwd").mockReturnValue(cwd)
		vi.stubEnv("KIMCHI_REGION", undefined)
		vi.stubEnv("KIMCHI_WEB_APP_URL", undefined)
		vi.stubEnv("KIMCHI_REMOTE_ENDPOINT", undefined)
		vi.stubEnv("KIMCHI_BASE_URL", undefined)
		invalidateResolvedEndpoints()
	})

	afterAll(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		rmSync(home, { recursive: true, force: true })
	})

	it("keeps the stored selfHostedEndpoints when switching away and back to self-hosted", async () => {
		writeFileSync(
			configPath,
			JSON.stringify({ apiKey: "k", region: "self-hosted", selfHostedEndpoints: LEGACY_LAYOUT }),
		)
		expect(resolveEndpoints().webAppUrl).toBe("https://kimchi.example.com")

		// Switch away to the US region: the base URL stays stored (it is only
		// consulted when the region is self-hosted).
		writeApiKey("us-token", configPath, { region: "us", llmEndpoint: "https://llm.kimchi.dev/openai/v1" })
		expect(resolveEndpoints().region).toBe("us")
		expect(resolveEndpoints().webAppUrl).toBe("https://app.kimchi.dev")

		// Switch back (a re-login persists the region; the login flow offers
		// the stored console URL as the prompt default). Endpoints resolve from
		// the still-stored values again.
		writeApiKey("self-hosted-token", configPath, { region: "self-hosted" })
		const resolved = resolveEndpoints()
		expect(resolved.region).toBe("self-hosted")
		expect(resolved.webAppUrl).toBe("https://kimchi.example.com")
		expect(resolved.llmBaseUrl).toBe("https://kimchi.example.com/llm")
	})
})
