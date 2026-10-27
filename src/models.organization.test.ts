import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { applyOrganizationHeader, buildModelsConfig, type ModelMetadata } from "./models.js"

// loadConfig() reads the launch-time global config (real HOME). Pin it without
// a region so provider base URLs resolve the US gateway regardless of the
// developer machine's config (same pin as environment-models.test.ts).
vi.mock("./config.js", async (importActual) => {
	const actual = await importActual<typeof import("./config.js")>()
	return {
		...actual,
		loadConfig: () =>
			({ apiKey: process.env.KIMCHI_API_KEY ?? "", region: undefined }) as unknown as ReturnType<
				typeof actual.loadConfig
			>,
	}
})

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const metadata: ModelMetadata = {
	slug: "org-header-model",
	display_name: "Org Header Model",
	provider: "ai-enabler",
	reasoning: false,
	input_modalities: ["text"],
	is_serverless: false,
	limits: { context_window: 1000, max_output_tokens: 100 },
}

describe("buildModelsConfig organization header", () => {
	it("omits X-CastAi-Organization-Id when no organization is given (key login)", () => {
		const { providers } = buildModelsConfig([metadata], "https://example.invalid")
		for (const provider of Object.values(providers)) {
			expect(provider.headers?.["X-CastAi-Organization-Id"]).toBeUndefined()
		}
	})

	it("stamps X-CastAi-Organization-Id on every Kimchi provider when given (SSO login)", () => {
		const { providers } = buildModelsConfig([metadata], "https://example.invalid", "org-123")
		for (const [providerId, provider] of Object.entries(providers)) {
			expect(providerId.startsWith("kimchi")).toBe(true)
			expect(provider.headers?.["X-CastAi-Organization-Id"]).toBe("org-123")
		}
	})
})

describe("applyOrganizationHeader", () => {
	let modelsPath: string

	beforeEach(() => {
		const dir = mkdtempSync(join(tmpdir(), "kimchi-org-header-"))
		tempDirs.push(dir)
		modelsPath = join(dir, "models.json")
	})

	function writeModels(providers: Record<string, unknown>): void {
		writeFileSync(modelsPath, JSON.stringify({ providers }, null, "\t"), "utf-8")
	}

	function readModels(): Record<string, { headers?: Record<string, string> }> {
		return (
			JSON.parse(readFileSync(modelsPath, "utf-8")) as {
				providers: Record<string, { headers?: Record<string, string> }>
			}
		).providers
	}

	it("adds the header to every Kimchi provider without touching other fields", () => {
		writeModels({
			"kimchi-dev": { baseUrl: "https://example.invalid", models: [{ id: "m" }] },
			"kimchi-dev/openai": { baseUrl: "https://example.invalid", headers: { "X-Provider-Type": "openai" } },
			"kimi-coding": { headers: {} },
			ollama: { headers: { "X-Provider-Type": "ollama" } },
		})

		applyOrganizationHeader(modelsPath, "org-9")

		const providers = readModels()
		expect(providers["kimchi-dev"]?.headers?.["X-CastAi-Organization-Id"]).toBe("org-9")
		expect(providers["kimchi-dev/openai"]?.headers?.["X-CastAi-Organization-Id"]).toBe("org-9")
		// Existing headers survive the merge.
		expect(providers["kimchi-dev/openai"]?.headers?.["X-Provider-Type"]).toBe("openai")
		// Non-Kimchi providers are untouched.
		expect(providers["kimi-coding"]?.headers?.["X-CastAi-Organization-Id"]).toBeUndefined()
		expect(providers.ollama?.headers?.["X-CastAi-Organization-Id"]).toBeUndefined()
		// Untouched model entries survive.
		expect(providers["kimchi-dev"]).toMatchObject({ models: [{ id: "m" }] })
	})

	it("is a no-op write when every Kimchi provider already carries the org", () => {
		writeModels({
			"kimchi-dev": { headers: { "X-CastAi-Organization-Id": "org-1" } },
		})
		const before = readFileSync(modelsPath, "utf-8")
		applyOrganizationHeader(modelsPath, "org-1")
		expect(readFileSync(modelsPath, "utf-8")).toBe(before)
	})

	it("strips a stale header when called without an organization (key login)", () => {
		writeModels({
			"kimchi-dev": { headers: { "X-CastAi-Organization-Id": "org-old", "X-Provider-Type": "ai-enabler" } },
			"kimchi-experimental": { headers: { "X-CastAi-Organization-Id": "org-old" } },
			ollama: { headers: { "X-Provider-Type": "ollama" } },
		})

		applyOrganizationHeader(modelsPath, undefined)

		const providers = readModels()
		expect(providers["kimchi-dev"]?.headers).toEqual({ "X-Provider-Type": "ai-enabler" })
		expect(providers["kimchi-experimental"]?.headers).toEqual({})
		expect(providers.ollama?.headers).toEqual({ "X-Provider-Type": "ollama" })
	})

	it("tolerates a missing or unparsable models.json", () => {
		expect(() => applyOrganizationHeader(join(modelsPath, "does-not-exist.json"), "org-1")).not.toThrow()
		writeFileSync(modelsPath, "not json", "utf-8")
		expect(() => applyOrganizationHeader(modelsPath, "org-1")).not.toThrow()
	})
})
