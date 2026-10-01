import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

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

const { invalidateResolvedEndpoints, resolveEndpoints } = await import("./config.js")

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
