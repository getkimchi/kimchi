import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai"
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isCredentialStale, markCredentialStale, resetCredentialStalenessForTests } from "./credential-staleness.js"
import { AUTO_MODEL_DESCRIPTION } from "./extensions/auto-model/constants.js"
import { readModelDeprecations } from "./model-deprecation.js"
import {
	__clearModelDescriptionsForTest,
	buildModelsConfig,
	getModelDescription,
	injectExperimentalProvider,
	isTransientModelsError,
	ModelsFetchError,
	readExperimentalModels,
	updateModelsConfig,
} from "./models.js"

// loadConfig() reads the launch-time global config (real HOME). Pin it without
// a region so endpoint derivation (experimental provider, metadata defaults)
// resolves the US URLs regardless of the developer machine's config.
vi.mock("./config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./config.js")>()
	return {
		...actual,
		loadConfig: () =>
			({ apiKey: process.env.KIMCHI_API_KEY ?? "", region: undefined }) as unknown as ReturnType<
				typeof actual.loadConfig
			>,
	}
})

const KIMI: unknown = {
	slug: "kimi-k2.5",
	display_name: "Kimi K2.5",
	provider: "ai-enabler",
	reasoning: true,
	input_modalities: ["text", "image"],
	is_serverless: true,
	limits: { context_window: 262144, max_output_tokens: 262144 },
}

const GLM: unknown = {
	slug: "glm-5-fp8",
	display_name: "GLM-5 FP8",
	provider: "ai-enabler",
	reasoning: true,
	input_modalities: ["text"],
	is_serverless: true,
	limits: { context_window: 202752, max_output_tokens: 202752 },
}

const SONNET_46: unknown = {
	slug: "claude-sonnet-4-6",
	display_name: "",
	provider: "anthropic",
	reasoning: true,
	input_modalities: ["text", "image"],
	is_serverless: false,
	limits: { context_window: 1_000_000, max_output_tokens: 128_000 },
}

const OPUS_46: unknown = {
	slug: "claude-opus-4-6",
	display_name: "",
	provider: "anthropic",
	reasoning: true,
	input_modalities: ["text", "image"],
	is_serverless: false,
	limits: { context_window: 1_000_000, max_output_tokens: 128_000 },
}

const CUSTOM_PROVIDER = {
	baseUrl: "https://custom.example/v1",
	apiKey: "custom-key",
	api: "openai-completions",
	authHeader: true,
	models: [
		{
			id: "custom-model",
			name: "Custom Model",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	],
}

describe("updateModelsConfig", () => {
	let tempDir: string
	let modelsJsonPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-models-test-"))
		modelsJsonPath = join(tempDir, "models.json")
		vi.stubGlobal("fetch", vi.fn())
		resetCredentialStalenessForTests()
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	// 401 on refresh = dead key, not absent (presence can't tell);
	// auth_status must read logged-out for it.
	describe("credential staleness signaling", () => {
		it("marks the api key stale when the refresh is rejected with 401", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
			} as Response)

			// No cache on disk → updateModelsConfig rethrows; the stale mark
			// must survive either path.
			await updateModelsConfig(modelsJsonPath, "dead-key", { sleep: async () => {} }).catch(() => {})

			expect(isCredentialStale("dead-key", "kimchi-dev")).toBe(true)
			// Unrelated keys are untouched.
			expect(isCredentialStale("some-other-key", "kimchi-dev")).toBe(false)
		})

		it("does not mark on non-auth failures (500) — a login pane cannot fix those", async () => {
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
			} as Response)

			await updateModelsConfig(modelsJsonPath, "some-key", { sleep: async () => {} }).catch(() => {})

			expect(isCredentialStale("some-key", "kimchi-dev")).toBe(false)
		})

		// Re-login success wipes all marks (fresh key + revived OAuth).
		it("clears all staleness marks for kimchi-dev when a refresh succeeds", async () => {
			markCredentialStale("dead-key", "kimchi-dev")
			markCredentialStale(undefined, "kimchi-dev")
			vi.mocked(fetch).mockResolvedValueOnce({
				ok: true,
				json: async () => ({ models: [KIMI] }),
			} as Response)

			await updateModelsConfig(modelsJsonPath, "fresh-key", { sleep: async () => {} })

			expect(isCredentialStale("dead-key", "kimchi-dev")).toBe(false)
			expect(isCredentialStale(undefined, "kimchi-dev")).toBe(false)
		})
	})

	it("maps each metadata field into the pi-mono model config", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].apiKey).toBe("$KIMCHI_API_KEY")
		expect(config.providers["kimchi-dev"].models).toEqual([
			{
				id: "kimi-k2.5",
				name: "Kimi K2.5",
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 262144,
				maxTokens: 262144,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				provider: "ai-enabler",
				thinkingLevelMap: { off: "none", max: "max" },
			},
		])
	})

	it("passes input_modalities through directly", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [GLM] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].models[0].input).toEqual(["text"])
	})

	it("routes Anthropic models through the native messages API", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [SONNET_46] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev/anthropic"]).toBeDefined()
		expect(config.providers["kimchi-dev/anthropic"].api).toBe("anthropic-messages")
		expect(config.providers["kimchi-dev/anthropic"].baseUrl).toBe("https://llm.kimchi.dev/anthropic")

		const model = config.providers["kimchi-dev/anthropic"].models[0]
		const upstream = ANTHROPIC_MODELS["claude-sonnet-4-6"]
		expect(model.compat).toEqual(upstream.compat)
		expect(model.thinkingLevelMap).toEqual(upstream.thinkingLevelMap)
	})

	it("leaves compat unset for anthropic models not in the upstream catalog", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				models: [
					{
						slug: "claude-unknown-9",
						display_name: "Claude Unknown 9",
						provider: "anthropic",
						reasoning: true,
						input_modalities: ["text", "image"],
						is_serverless: false,
						limits: { context_window: 1_000_000, max_output_tokens: 128_000 },
					},
				],
			}),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		const model = config.providers["kimchi-dev/anthropic"].models[0]
		expect(model).not.toHaveProperty("compat")
		expect(model).not.toHaveProperty("thinkingLevelMap")
	})

	it("sets X-Provider-Type header at the provider level for all kimchi providers", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [SONNET_46, KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		// base kimchi-dev provider routes ai-enabler models
		expect(config.providers["kimchi-dev"].headers["X-Provider-Type"]).toBe("ai-enabler")
		expect(config.providers["kimchi-dev"].headers["User-Agent"]).toMatch(/^kimchi\//)

		// anthropic sub-provider has the header
		expect(config.providers["kimchi-dev/anthropic"].headers["X-Provider-Type"]).toBe("anthropic")
	})

	it("does not set compat for non-anthropic ai-enabler models", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].models[0]).not.toHaveProperty("compat")
	})

	it("maps ai-enabler thinking levels required by the upstream selector", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		const model = config.providers["kimchi-dev"].models[0]
		expect(model.thinkingLevelMap).toEqual({
			off: "none",
			max: "max",
		})
		expect(getSupportedThinkingLevels(model)).toContain("max")
	})

	it("routes claude-* models from non-anthropic providers through openai-completions with compat flags", async () => {
		const CLAUDE_ON_AZURE: unknown = {
			slug: "claude-sonnet-4-6",
			display_name: "",
			provider: "azure_ai",
			reasoning: true,
			input_modalities: ["text", "image"],
			is_serverless: false,
			limits: { context_window: 1_000_000, max_output_tokens: 128_000 },
		}
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [CLAUDE_ON_AZURE] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev/azure_ai"]).toBeDefined()
		expect(config.providers["kimchi-dev/azure_ai"].api).toBe("openai-completions")
		expect(config.providers["kimchi-dev/azure_ai"].baseUrl).toBe("https://llm.kimchi.dev/openai/v1")
		expect(config.providers["kimchi-dev/azure_ai"].models[0].compat).toEqual({
			supportsReasoningEffort: false,
			cacheControlFormat: "anthropic",
			supportsUsageInStreaming: true,
		})
	})

	it("splits ai-enabler models into kimchi-dev and non-ai-enabler models into kimchi-dev/{provider}", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [OPUS_46, GLM, SONNET_46, KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(Object.keys(config.providers)).toEqual(["kimchi-dev", "kimchi-dev/anthropic"])

		// ai-enabler models stay in kimchi-dev
		const devIds = config.providers["kimchi-dev"].models.map((m: { id: string }) => m.id)
		expect(devIds).toEqual(["glm-5-fp8", "kimi-k2.5"])

		// anthropic models go to kimchi-dev/anthropic
		const anthropicIds = config.providers["kimchi-dev/anthropic"].models.map((m: { id: string }) => m.id)
		expect(anthropicIds).toEqual(["claude-opus-4-6", "claude-sonnet-4-6"])

		// kimchi-dev stays on openai-completions; anthropic moves to messages
		expect(config.providers["kimchi-dev"].api).toBe("openai-completions")
		expect(config.providers["kimchi-dev/anthropic"].api).toBe("anthropic-messages")
		expect(config.providers["kimchi-dev/anthropic"].baseUrl).toBe("https://llm.kimchi.dev/anthropic")
	})

	it("uses correct URL, Authorization header, and timeout", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "my-api-key")

		expect(fetch).toHaveBeenCalledWith(
			"https://llm.kimchi.dev/v1/models/metadata?include_in_cli=true",
			expect.objectContaining({
				headers: { Authorization: "Bearer my-api-key" },
				signal: expect.any(AbortSignal),
			}),
		)
	})

	it("uses a provided Kimchi endpoint for metadata fetch and kimchi-dev baseUrl", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "my-api-key", { endpoint: "https://custom.kimchi.example/" })

		expect(fetch).toHaveBeenCalledWith(
			"https://custom.kimchi.example/v1/models/metadata?include_in_cli=true",
			expect.objectContaining({
				headers: { Authorization: "Bearer my-api-key" },
			}),
		)
		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].baseUrl).toBe("https://custom.kimchi.example/openai/v1")
	})

	it("returns discovered metadata when fetch succeeds", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI, GLM] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		expect(result.models.map((m) => m.slug)).toEqual(["glm-5-fp8", "kimi-k2.5"])
	})

	it("preserves user-added providers when updating models.json", async () => {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: { custom: { models: [] } } }))
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key", { endpoint: "https://custom.kimchi.example" })

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].models.map((m: { id: string }) => m.id)).toEqual(["kimi-k2.5"])
		expect(config.providers["kimchi-dev"].baseUrl).toBe("https://custom.kimchi.example/openai/v1")
		expect(config.providers.custom).toEqual({ models: [] })
	})

	it("includes models from non-kimchi providers in the returned list", async () => {
		const OPENAI_MODEL = {
			id: "gpt-4",
			name: "GPT-4",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			provider: "openai",
		}

		writeFileSync(modelsJsonPath, JSON.stringify({ providers: { openai: { models: [OPENAI_MODEL] } } }))
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		const slugs = result.models.map((m) => m.slug)
		expect(slugs).toContain("kimi-k2.5")
		expect(slugs).toContain("gpt-4")
	})

	it("reads subscription provider models from existing models.json on startup", async () => {
		const OPENAI_MODEL = {
			id: "o1-pro",
			name: "o1 Pro",
			reasoning: false,
			input: ["text"],
			contextWindow: 200000,
			maxTokens: 100000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			provider: "openai",
		}

		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"kimchi-dev": {
						baseUrl: "https://llm.kimchi.dev",
						apiKey: "$KIMCHI_API_KEY",
						api: "openai-completions",
						models: [OPENAI_MODEL],
					},
					openai: {
						models: [OPENAI_MODEL],
					},
				},
			}),
		)

		// API returns a different Kimchi model
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		const slugs = result.models.map((m) => m.slug)
		expect(slugs).toContain("kimi-k2.5") // from API
		expect(slugs).toContain("o1-pro") // from cached providers

		const written = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(written.providers.openai.models).toHaveLength(1)
	})

	it("throws after exhausting retries on network errors when no cache exists", async () => {
		vi.mocked(fetch).mockRejectedValue(new Error("network error"))
		const error = await updateModelsConfig(modelsJsonPath, "test-key", { sleep: async () => {} }).catch((e) => e)

		expect(error).toBeInstanceOf(ModelsFetchError)
		expect(isTransientModelsError(error)).toBe(true)
		expect((error as Error).message).toContain("network error")
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	it("retries a network error and succeeds on a later attempt", async () => {
		vi.mocked(fetch)
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ models: [KIMI] }),
			} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key", { sleep: async () => {} })

		expect(fetch).toHaveBeenCalledTimes(2)
		expect(result.models.map((m) => m.slug)).toEqual(["kimi-k2.5"])
	})

	it("retries a timeout error and succeeds on a later attempt", async () => {
		vi.mocked(fetch)
			.mockRejectedValueOnce(new Error("The operation timed out."))
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ models: [KIMI] }),
			} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key", { sleep: async () => {} })

		expect(fetch).toHaveBeenCalledTimes(2)
		expect(result.models.map((m) => m.slug)).toEqual(["kimi-k2.5"])
	})

	it("retries a 200 response with an unparseable body and succeeds on a later attempt", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce({
				ok: true,
				headers: { get: () => null },
				json: async () => {
					throw new SyntaxError("Unexpected token < in JSON at position 0")
				},
			} as unknown as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ models: [KIMI] }),
			} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key", { sleep: async () => {} })

		expect(fetch).toHaveBeenCalledTimes(2)
		expect(result.models.map((m) => m.slug)).toEqual(["kimi-k2.5"])
	})

	it("classifies a persistent unparseable body as transient after exhausting retries", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			headers: { get: () => null },
			json: async () => {
				throw new SyntaxError("Unexpected end of JSON input")
			},
		} as unknown as Response)

		const error = await updateModelsConfig(modelsJsonPath, "test-key", { sleep: async () => {} }).catch((e) => e)

		expect(error).toBeInstanceOf(ModelsFetchError)
		expect(isTransientModelsError(error)).toBe(true)
		expect((error as Error).message).toContain("Failed to parse models response")
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	it("throws on non-ok response when no cached config exists", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
		} as Response)
		await expect(updateModelsConfig(modelsJsonPath, "bad-key")).rejects.toThrow(
			"Failed to fetch models: 401 Unauthorized",
		)
	})

	it("retries a transient 429 and succeeds on a later attempt", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce({
				ok: false,
				status: 429,
				statusText: "Too Many Requests",
				headers: { get: () => null },
			} as unknown as Response)
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ models: [KIMI] }),
			} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key", { sleep: async () => {} })

		expect(fetch).toHaveBeenCalledTimes(2)
		expect(result.models.map((m) => m.slug)).toEqual(["kimi-k2.5"])
	})

	it("classifies a persistent 429 as transient after exhausting retries", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: false,
			status: 429,
			statusText: "Too Many Requests",
			headers: { get: () => null },
		} as unknown as Response)

		const error = await updateModelsConfig(modelsJsonPath, "test-key", { sleep: async () => {} }).catch((e) => e)

		expect(isTransientModelsError(error)).toBe(true)
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	it("classifies a 401 as a non-transient error and does not retry", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
		} as Response)

		const error = await updateModelsConfig(modelsJsonPath, "bad-key").catch((e) => e)

		expect(error).toBeInstanceOf(ModelsFetchError)
		expect(isTransientModelsError(error)).toBe(false)
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it("throws on unexpected response shape when no cached config exists", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ data: "unexpected" }),
		} as Response)
		await expect(updateModelsConfig(modelsJsonPath, "test-key")).rejects.toThrow(
			"Unexpected response shape from models API",
		)
	})

	it("throws when API returns empty list and no cached config exists", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [] }),
		} as Response)
		await expect(updateModelsConfig(modelsJsonPath, "test-key")).rejects.toThrow("API returned empty model list")
	})

	it("falls back to cached metadata and non-kimchi providers when fetch fails", async () => {
		const OPENAI_MODEL = {
			id: "gpt-4",
			name: "GPT-4",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			provider: "openai",
		}

		// Seed a successful fetch so the cache is populated.
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI, SONNET_46] }),
		} as Response)
		await updateModelsConfig(modelsJsonPath, "test-key")
		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		config.providers.openai = { models: [OPENAI_MODEL] }
		writeFileSync(modelsJsonPath, JSON.stringify(config))
		vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"))

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		// Cache round-trip loses is_serverless, so all entries land in the
		// non-serverless group and order alphabetically.
		expect(result.models.map((m) => m.slug)).toEqual(["claude-sonnet-4-6", "gpt-4", "kimi-k2.5"])
	})

	it("falls back to cached metadata after exhausting network retries", async () => {
		const OPENAI_MODEL = {
			id: "gpt-4",
			name: "GPT-4",
			reasoning: false,
			input: ["text"],
			contextWindow: 8192,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			provider: "openai",
		}

		// Seed cache with a successful fetch
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI, SONNET_46] }),
		} as Response)
		await updateModelsConfig(modelsJsonPath, "test-key")
		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		config.providers.openai = { models: [OPENAI_MODEL] }
		writeFileSync(modelsJsonPath, JSON.stringify(config))
		vi.mocked(fetch).mockClear()

		// All retry attempts fail — proves fallback works after retry exhaustion
		vi.mocked(fetch).mockRejectedValue(new Error("network down"))

		const result = await updateModelsConfig(modelsJsonPath, "test-key", { sleep: async () => {} })

		// Cache + custom provider are returned (alphabetical within the
		// non-serverless group — is_serverless is not persisted).
		expect(result.models.map((m) => m.slug)).toEqual(["claude-sonnet-4-6", "gpt-4", "kimi-k2.5"])
		// Confirms retry exhaustion actually happened (3 attempts, no success)
		expect(fetch).toHaveBeenCalledTimes(3)
	})

	it("falls back to cached metadata when API returns empty list", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)
		await updateModelsConfig(modelsJsonPath, "test-key")
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		expect(result.models.map((m) => m.slug)).toEqual(["kimi-k2.5"])
	})

	it("falls back to cached Kimchi models after a 401 without custom providers", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(Response.json({ models: [KIMI] }))
		await updateModelsConfig(modelsJsonPath, "saved-key")
		const original = readFileSync(modelsJsonPath, "utf-8")
		vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401, statusText: "Unauthorized" }))
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const result = await updateModelsConfig(modelsJsonPath, "rejected-key")
		expect(result.models.map((model) => model.slug)).toEqual(["kimi-k2.5"])
		expect(isCredentialStale("rejected-key", "kimchi-dev")).toBe(true)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("401 Unauthorized"))
		expect(readFileSync(modelsJsonPath, "utf-8")).toBe(original)
	})

	it.each([false, true])("preserves custom providers after a Kimchi 401 (Kimchi cache=%s)", async (withKimchiCache) => {
		if (withKimchiCache) {
			vi.mocked(fetch).mockResolvedValueOnce(Response.json({ models: [KIMI] }))
			await updateModelsConfig(modelsJsonPath, "saved-key")
		}
		const config = withKimchiCache ? JSON.parse(readFileSync(modelsJsonPath, "utf-8")) : { providers: {} }
		config.providers.custom = CUSTOM_PROVIDER
		writeFileSync(modelsJsonPath, JSON.stringify(config))
		const original = readFileSync(modelsJsonPath, "utf-8")
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401, statusText: "Unauthorized" }))

		const result = await updateModelsConfig(modelsJsonPath, "expired-kimchi-key")

		expect(result.models.map((model) => model.slug)).toContain("custom-model")
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("401 Unauthorized"))
		expect(readFileSync(modelsJsonPath, "utf-8")).toBe(original)
	})

	it("rejects invalid credentials during strict discovery even when custom providers exist", async () => {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: { custom: CUSTOM_PROVIDER } }))
		const original = readFileSync(modelsJsonPath, "utf-8")
		vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401, statusText: "Unauthorized" }))

		await expect(
			updateModelsConfig(modelsJsonPath, "rejected-key", { allowCachedFallback: false }),
		).rejects.toMatchObject({ status: 401 })
		expect(readFileSync(modelsJsonPath, "utf-8")).toBe(original)
	})

	it("does not overwrite cached models.json when fetch fails", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)
		await updateModelsConfig(modelsJsonPath, "test-key")
		const original = readFileSync(modelsJsonPath, "utf-8")
		vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"))
		await updateModelsConfig(modelsJsonPath, "test-key")

		expect(readFileSync(modelsJsonPath, "utf-8")).toBe(original)
	})

	it("does not persist an endpoint override into models.json when the refresh fails (no global pollution)", async () => {
		// Seed the cache via a successful gateway fetch → baseUrl = gateway on disk.
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)
		await updateModelsConfig(modelsJsonPath, "test-key")
		const original = readFileSync(modelsJsonPath, "utf-8")

		// A project-local override whose metadata endpoint is unreachable → fall back to cache.
		vi.mocked(fetch).mockRejectedValue(new Error("network down"))
		await updateModelsConfig(modelsJsonPath, "test-key", {
			endpoint: "https://project-override.example",
			sleep: async () => {},
		})

		// models.json is a GLOBAL file; a project-local llmEndpoint must never be written into it.
		// The override is applied in-memory by the login extension, so the file stays byte-for-byte
		// and keeps pointing at the gateway. Guards the disk-write regression from #814.
		const after = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(after.providers["kimchi-dev"].baseUrl).toBe("https://llm.kimchi.dev/openai/v1")
		expect(readFileSync(modelsJsonPath, "utf-8")).toBe(original)
	})

	it("prefixes a scheme-less endpoint with https:// for the metadata URL and kimchi-dev baseUrl", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key", { endpoint: "example.com" })

		// A bare "example.com" would otherwise be an invalid request URL that the HTTP layer
		// silently drops, falling back to the gateway (the original #814 bug).
		expect(fetch).toHaveBeenCalledWith(
			"https://example.com/v1/models/metadata?include_in_cli=true",
			expect.objectContaining({ headers: { Authorization: "Bearer test-key" } }),
		)
		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].baseUrl).toBe("https://example.com/openai/v1")
	})

	it("creates nested directories if they do not exist", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		const nestedPath = join(tempDir, "a", "b", "models.json")
		await updateModelsConfig(nestedPath, "test-key")

		expect(existsSync(nestedPath)).toBe(true)
	})

	it("returns non-kimchi provider models without fetching when apiKey is empty", async () => {
		const OPENAI_MODEL = {
			id: "gpt-4o",
			name: "GPT-4o",
			reasoning: false,
			input: ["text", "image"],
			contextWindow: 128000,
			maxTokens: 16384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			provider: "openai",
		}
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: { openai: { models: [OPENAI_MODEL] } } }))

		const result = await updateModelsConfig(modelsJsonPath, "")

		expect(result.models.map((m) => m.slug)).toEqual(["gpt-4o"])
		expect(fetch).not.toHaveBeenCalled()
	})

	it("returns empty models without fetching when apiKey is empty and no cache exists", async () => {
		const result = await updateModelsConfig(modelsJsonPath, "")

		expect(result).toEqual({ models: [] })
		expect(fetch).not.toHaveBeenCalled()
		expect(existsSync(modelsJsonPath)).toBe(false)
	})

	it("filters out sunset models from models.json and returned list", async () => {
		const sunsetModel = {
			slug: "old-model",
			display_name: "Old Model",
			provider: "ai-enabler",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 100_000, max_output_tokens: 4096 },
			sunset_at: "2020-01-01T00:00:00Z",
		}
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI, sunsetModel] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		const writtenIds = config.providers["kimchi-dev"].models.map((m: { id: string }) => m.id)
		expect(writtenIds).toEqual(["kimi-k2.5"])
		expect(result.models.map((m) => m.slug)).toEqual(["kimi-k2.5"])
	})

	it("warns when all API models are sunset", async () => {
		const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const sunsetModel = {
			slug: "old-model",
			display_name: "Old Model",
			provider: "ai-enabler",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 100_000, max_output_tokens: 4096 },
			sunset_at: "2020-01-01T00:00:00Z",
		}
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [sunsetModel] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		expect(consoleWarnSpy).toHaveBeenCalledWith(
			expect.stringContaining("All models from the API are deprecated or sunset"),
		)
		expect(result.models).toHaveLength(0)
		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].models).toHaveLength(0)
		consoleWarnSpy.mockRestore()
	})

	it("throws without changing models.json when strict fresh discovery finds no active Kimchi models", async () => {
		const existingConfig = {
			providers: {
				openai: { models: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }] },
				"kimchi-dev": { models: [{ id: "old-kimchi", name: "Old Kimchi", provider: "ai-enabler" }] },
			},
		}
		writeFileSync(modelsJsonPath, JSON.stringify(existingConfig, null, "\t"), "utf-8")
		const before = readFileSync(modelsJsonPath, "utf-8")
		const sunsetModel = {
			slug: "old-model",
			display_name: "Old Model",
			provider: "ai-enabler",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 100_000, max_output_tokens: 4096 },
			sunset_at: "2020-01-01T00:00:00Z",
		}
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [sunsetModel] }),
		} as Response)

		await expect(updateModelsConfig(modelsJsonPath, "test-key", { requireActiveModels: true })).rejects.toThrow(
			"No active Kimchi models are available for this API key",
		)

		expect(readFileSync(modelsJsonPath, "utf-8")).toBe(before)
	})

	it("treats models without deprecation fields as active", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].models).toHaveLength(1)
		expect(result.models.map((m) => m.slug)).toEqual(["kimi-k2.5"])
	})

	it("preserves deprecated models in models.json and returned list", async () => {
		const deprecatedModel = {
			slug: "deprecated-model",
			display_name: "Deprecated Model",
			provider: "ai-enabler",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 100_000, max_output_tokens: 4096 },
			deprecated_at: "2099-01-01T00:00:00Z",
		}
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI, deprecatedModel] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		const writtenIds = config.providers["kimchi-dev"].models.map((m: { id: string }) => m.id)
		expect(writtenIds).toContain("deprecated-model")
		expect(result.models.map((m) => m.slug)).toContain("deprecated-model")
	})

	it("keeps announced and past-deprecated models until sunset, drops only sunset, and persists deprecation to the sidecar", async () => {
		const freshModel = {
			slug: "fresh-model",
			display_name: "Fresh Model",
			provider: "ai-enabler",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 100_000, max_output_tokens: 4096 },
		}
		const announcedModel = {
			slug: "old-model",
			display_name: "Old Model",
			provider: "ai-enabler",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 100_000, max_output_tokens: 4096 },
			deprecated_at: "2099-01-01T00:00:00Z",
			replacement_model: "new-model",
		}
		// Past deprecated_at, future sunset_at: still listed and served
		// (proxy translates to the replacement), so the harness keeps it.
		const pastDeprecatedModel = {
			...announcedModel,
			slug: "in-window-model",
			deprecated_at: "2020-01-01T00:00:00Z",
			sunset_at: "2099-01-01T00:00:00Z",
		}
		const sunsetModel = { ...announcedModel, slug: "gone-model", sunset_at: "2020-01-01T00:00:00Z" }
		// Sunset-only record (vendor retirement, no announced deprecation):
		// joins the de-emphasized tail with the deprecated entries.
		const retiringModel = {
			...announcedModel,
			slug: "aaa-retiring-model",
			deprecated_at: undefined,
			replacement_model: undefined,
			sunset_at: "2099-01-01T00:00:00Z",
		}
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [announcedModel, pastDeprecatedModel, sunsetModel, freshModel, retiringModel] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		// Announced models stay available with their deprecation fields intact.
		const model = result.models.find((m) => m.slug === "old-model")
		expect(model?.deprecated_at).toBe("2099-01-01T00:00:00Z")
		expect(model?.replacement_model).toBe("new-model")
		// Past-deprecated-but-not-sunset models stay listed (served until sunset).
		const inWindow = result.models.find((m) => m.slug === "in-window-model")
		expect(inWindow?.sunset_at).toBe("2099-01-01T00:00:00Z")
		// Entries with any deprecation signal (announced, past, or
		// sunset-only) sort after active ones, alphabetically within the group.
		const slugs = result.models.map((m) => m.slug)
		expect(slugs).toEqual(["fresh-model", "aaa-retiring-model", "in-window-model", "old-model"])
		// Past-sunset models are excluded from the active list.
		expect(result.models.some((m) => m.slug === "gone-model")).toBe(false)

		// Sidecar holds all entries: vanishing models keep replacement info.
		const sidecar = readModelDeprecations(modelsJsonPath)
		expect(sidecar.get("old-model")?.replacement_model).toBe("new-model")
		expect(sidecar.get("in-window-model")?.replacement_model).toBe("new-model")
		expect(sidecar.get("gone-model")?.replacement_model).toBe("new-model")
	})
})

describe("readExistingProviders strips kimchi-experimental", () => {
	let tempDir: string
	let modelsJsonPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-models-exp-test-"))
		modelsJsonPath = join(tempDir, "models.json")
		vi.stubGlobal("fetch", vi.fn())
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("clobbers kimchi-experimental on the next updateModelsConfig call", async () => {
		// Simulate a previous run that left kimchi-experimental in models.json
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"kimchi-experimental": {
						baseUrl: "https://llm.kimchi.dev/experimental/openai/v1",
						apiKey: "some-key",
						api: "openai-completions",
						authHeader: true,
						headers: {},
						models: [],
					},
				},
			}),
		)

		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-experimental"]).toBeUndefined()
	})
})

describe("injectExperimentalProvider", () => {
	let tempDir: string
	let modelsJsonPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-inject-exp-test-"))
		modelsJsonPath = join(tempDir, "models.json")
		vi.stubGlobal("fetch", vi.fn())
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("is a no-op when kimchi-dev is absent", () => {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: {} }))
		injectExperimentalProvider(modelsJsonPath, "test-api-key")
		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-experimental"]).toBeUndefined()
	})

	it("copies the kimchi-dev block with kimchi-experimental baseUrl", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)
		await updateModelsConfig(modelsJsonPath, "test-key")

		injectExperimentalProvider(modelsJsonPath, "test-api-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		const dev = config.providers["kimchi-dev"]
		const exp = config.providers["kimchi-experimental"]

		expect(exp).toBeDefined()
		expect(exp.baseUrl).toBe("https://llm.kimchi.dev/experimental/openai/v1")
		expect(exp.apiKey).toBe("test-api-key")
		expect(exp.api).toBe(dev.api)
		expect(exp.authHeader).toBe(dev.authHeader)
		expect(exp.models).toEqual(dev.models)
	})

	it("preserves other providers when injecting", async () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"kimchi-dev": {
						baseUrl: "https://llm.kimchi.dev/openai/v1",
						apiKey: "KIMCHI_API_KEY",
						api: "openai-completions",
						authHeader: true,
						headers: {},
						models: [],
					},
					"my-custom": { baseUrl: "https://custom.example.com", models: [] },
				},
			}),
		)

		injectExperimentalProvider(modelsJsonPath, "test-api-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["my-custom"]).toBeDefined()
		expect(config.providers["kimchi-experimental"]).toBeDefined()
	})

	it("is a no-op when models.json does not exist", () => {
		injectExperimentalProvider(modelsJsonPath, "test-api-key")
		expect(existsSync(modelsJsonPath)).toBe(false)
	})
})

describe("embedding model filtering", () => {
	let tempDir: string
	let modelsJsonPath: string

	const EMBEDDING_MODEL: unknown = {
		slug: "text-embedding-3-small",
		display_name: "",
		provider: "openai",
		tool_call: false,
		reasoning: false,
		supports_images: false,
		input_modalities: ["text"],
		is_serverless: false,
		is_routable: false,
		limits: { context_window: 8191, max_output_tokens: 0 },
	}

	const GPT5: unknown = {
		slug: "gpt-5",
		display_name: "",
		provider: "openai",
		tool_call: true,
		reasoning: true,
		supports_images: true,
		input_modalities: ["text", "image"],
		is_serverless: false,
		is_routable: false,
		limits: { context_window: 272000, max_output_tokens: 128000 },
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-embedding-test-"))
		modelsJsonPath = join(tempDir, "models.json")
		vi.stubGlobal("fetch", vi.fn())
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("filters out embedding models with max_output_tokens: 0", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI, EMBEDDING_MODEL] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		const writtenIds = config.providers["kimchi-dev"].models.map((m: { id: string }) => m.id)
		expect(writtenIds).not.toContain("text-embedding-3-small")
	})

	it("preserves valid chat models alongside filtered embedding models", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI, GPT5, EMBEDDING_MODEL] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		const slugs = result.models.map((m) => m.slug)
		expect(slugs).toContain("kimi-k2.5")
		expect(slugs).toContain("gpt-5")
		expect(slugs).not.toContain("text-embedding-3-small")
	})

	it("handles response where all models are embeddings", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [EMBEDDING_MODEL] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		expect(result.models).toHaveLength(0)
		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].models).toHaveLength(0)
	})
})

describe("readExperimentalModels", () => {
	let tempDir: string
	let modelsJsonPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-read-exp-test-"))
		modelsJsonPath = join(tempDir, "models.json")
		vi.stubGlobal("fetch", vi.fn())
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("returns empty array when models.json does not exist", () => {
		expect(readExperimentalModels(modelsJsonPath)).toEqual([])
	})

	it("returns empty array when kimchi-experimental is absent", () => {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: { "kimchi-dev": { models: [] } } }))
		expect(readExperimentalModels(modelsJsonPath)).toEqual([])
	})

	it("returns ModelMetadata for each model in kimchi-experimental", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)
		await updateModelsConfig(modelsJsonPath, "test-key")
		injectExperimentalProvider(modelsJsonPath, "test-api-key")

		const result = readExperimentalModels(modelsJsonPath)
		expect(result).toHaveLength(1)
		expect(result[0].slug).toBe("kimi-k2.5")
	})
})

describe("model description registry (/model table DESCRIPTION column)", () => {
	let tempDir: string
	let modelsJsonPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-model-desc-test-"))
		modelsJsonPath = join(tempDir, "models.json")
		__clearModelDescriptionsForTest()
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		__clearModelDescriptionsForTest()
	})

	it("replaces fallback and stale descriptions on refresh and removes withdrawn descriptions", async () => {
		const metadata = (description?: string) => ({
			slug: "auto",
			display_name: "Auto",
			provider: "ai-enabler",
			reasoning: true,
			input_modalities: ["text", "image"],
			is_serverless: true,
			limits: { context_window: 262144, max_output_tokens: 32768 },
			description,
		})
		const fetchMock = vi.fn()
		vi.stubGlobal("fetch", fetchMock)
		for (const description of [undefined, "New backend description.", "Updated backend description.", undefined]) {
			fetchMock.mockResolvedValueOnce(Response.json({ models: [metadata(description)] }))
			await updateModelsConfig(modelsJsonPath, "test-key")
			expect(getModelDescription("kimchi-dev/auto")).toBe(description ?? AUTO_MODEL_DESCRIPTION)
		}
	})

	it("persists endpoint descriptions into models.json and registers them for the selector", async () => {
		vi.stubGlobal("fetch", vi.fn())
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				models: [
					{ ...(KIMI as Record<string, unknown>), description: "Flagship vision model." },
					{ ...(GLM as Record<string, unknown>) }, // no description
				],
			}),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")
		vi.restoreAllMocks()

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		const kimi = config.providers["kimchi-dev"].models.find((m: { id: string }) => m.id === "kimi-k2.5")
		const glm = config.providers["kimchi-dev"].models.find((m: { id: string }) => m.id === "glm-5-fp8")
		expect(kimi.description).toBe("Flagship vision model.")
		expect(glm.description).toBeUndefined()

		// Registry keyed by provider block + id — what the selector row sees.
		expect(getModelDescription("kimchi-dev/kimi-k2.5")).toBe("Flagship vision model.")
		expect(getModelDescription("kimchi-dev/glm-5-fp8")).toBeUndefined()
	})

	it("restores descriptions from the on-disk cache when offline (no API key)", async () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"kimchi-dev": {
						baseUrl: "https://llm.kimchi.dev/openai/v1",
						apiKey: "$KIMCHI_API_KEY",
						api: "openai-completions",
						models: [
							{
								id: "kimi-k2.5",
								name: "Kimi K2.5",
								provider: "ai-enabler",
								reasoning: true,
								input: ["text", "image"],
								contextWindow: 262144,
								maxTokens: 32768,
								description: "Cached description.",
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			}),
		)

		const result = await updateModelsConfig(modelsJsonPath, "")

		expect(getModelDescription("kimchi-dev/kimi-k2.5")).toBe("Cached description.")
		// modelToMetadata round-trips the description for the startup context.
		const model = (result.models as Array<{ slug: string; description?: string }>).find((m) => m.slug === "kimi-k2.5")
		expect(model?.description).toBe("Cached description.")
	})

	it("registers the Auto description as a fallback when serving the on-disk cache", async () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					"kimchi-dev": {
						baseUrl: "https://llm.kimchi.dev/openai/v1",
						models: [
							{
								id: "kimi-k2.5",
								name: "Kimi K2.5",
								provider: "ai-enabler",
								reasoning: true,
								input: ["text", "image"],
								contextWindow: 262144,
								maxTokens: 32768,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			}),
		)

		await updateModelsConfig(modelsJsonPath, "")

		expect(getModelDescription("kimchi-dev/auto")).toBe(AUTO_MODEL_DESCRIPTION)
		// Backend-owned catalog: the cache is served untouched — no virtual
		// auto is synthesized into models.json.
		const cached = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(cached.providers["kimchi-dev"].models.map((m: { id: string }) => m.id)).toEqual(["kimi-k2.5"])
	})

	it("a backend-owned auto without a description still gets the fallback constant", async () => {
		vi.stubGlobal("fetch", vi.fn())
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				models: [
					{
						slug: "auto",
						display_name: "Auto (Kimchi Router)",
						provider: "ai-enabler",
						reasoning: true,
						input_modalities: ["text", "image"],
						is_serverless: true,
						limits: { context_window: 1_000_000, max_output_tokens: 16_384 },
					},
					{
						slug: "glm-5.3",
						display_name: "GLM 5.3",
						provider: "ai-enabler",
						reasoning: true,
						input_modalities: ["text"],
						is_serverless: true,
						limits: { context_window: 1_000_000, max_output_tokens: 16_384 },
					},
				],
			}),
		} as Response)

		// The backend owns the catalog: the fetched entry passes through
		// untouched and the registry fallback fills its missing description.
		await updateModelsConfig(modelsJsonPath, "test-key")
		vi.restoreAllMocks()

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		const autos = config.providers["kimchi-dev"].models.filter((m: { id: string }) => m.id === "auto")
		expect(autos).toHaveLength(1)
		// The selector reads exactly this key.
		expect(getModelDescription("kimchi-dev/auto")).toBe(AUTO_MODEL_DESCRIPTION)
	})

	it("an endpoint-provided auto description wins over the fallback constant", async () => {
		vi.stubGlobal("fetch", vi.fn())
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				models: [
					{ ...(KIMI as Record<string, unknown>), slug: "auto", description: "Backend router with vision routing." },
				],
			}),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")
		// The registry fallback must not override the endpoint-provided description.
		vi.restoreAllMocks()

		expect(getModelDescription("kimchi-dev/auto")).toBe("Backend router with vision routing.")
	})
})

describe("openai Responses API routing", () => {
	function openaiModel(slug: string, overrides: Partial<{ reasoning: boolean }> = {}): unknown {
		return {
			slug,
			display_name: slug,
			provider: "openai",
			reasoning: overrides.reasoning ?? true,
			input_modalities: ["text"],
			is_serverless: false,
			limits: { context_window: 128000, max_output_tokens: 16384 },
		}
	}

	function openaiProviderModels(models: unknown[]) {
		const { providers } = buildModelsConfig(models as never, "https://example.invalid")
		return providers["kimchi-dev/openai"]?.models ?? []
	}

	it("routes Responses-capable OpenAI models through openai-responses", () => {
		const models = openaiProviderModels([
			openaiModel("gpt-5.6"),
			openaiModel("gpt-5.6-terra"),
			openaiModel("gpt-5.4-mini"),
			openaiModel("gpt-6-astra"),
			openaiModel("gpt-4o", { reasoning: false }),
			openaiModel("gpt-4.1-mini", { reasoning: false }),
			openaiModel("o4-mini"),
			openaiModel("o3-2025-04-16"),
		])
		expect(models).toHaveLength(8)
		for (const model of models) {
			expect(model.api).toBe("openai-responses")
		}
	})

	it("maps thinking off per model family — 'none' only where OpenAI accepts it", () => {
		const models = openaiProviderModels([
			openaiModel("o1"),
			openaiModel("o3"),
			openaiModel("o3-2025-04-16"),
			openaiModel("o3-mini"),
			openaiModel("o4-mini"),
			openaiModel("gpt-5"),
			openaiModel("gpt-5-2025-08-07"),
			openaiModel("gpt-5-mini"),
			openaiModel("gpt-5-nano"),
			openaiModel("gpt-5.1"),
			openaiModel("gpt-5.2"),
			openaiModel("gpt-5.4-mini"),
			openaiModel("gpt-5.6"),
			openaiModel("gpt-5.6-terra"),
			openaiModel("gpt-6-astra"),
		])
		expect(models).toHaveLength(15)
		for (const model of models) {
			expect(model.api).toBe("openai-responses")
		}
		// o-series: reasoning can be neither disabled nor minimized.
		for (const slug of ["o1", "o3", "o3-2025-04-16", "o3-mini", "o4-mini"]) {
			expect(models.find((m) => m.id === slug)?.thinkingLevelMap).toEqual({ off: null, minimal: null })
		}
		// base gpt-5 family: reasoning cannot be disabled.
		for (const slug of ["gpt-5", "gpt-5-2025-08-07", "gpt-5-mini", "gpt-5-nano"]) {
			expect(models.find((m) => m.id === slug)?.thinkingLevelMap).toEqual({ off: null })
		}
		// gpt-5.1+ / gpt-6 accept effort "none".
		for (const slug of ["gpt-5.1", "gpt-5.2", "gpt-5.4-mini", "gpt-5.6", "gpt-5.6-terra", "gpt-6-astra"]) {
			expect(models.find((m) => m.id === slug)?.thinkingLevelMap).toEqual({ off: "none" })
		}
	})

	it("keeps gpt-4o non-chat variants (audio/realtime/transcribe/tts) off the Responses route", () => {
		const models = openaiProviderModels([
			openaiModel("gpt-4o-audio-preview", { reasoning: false }),
			openaiModel("gpt-4o-mini-realtime-preview", { reasoning: false }),
			openaiModel("gpt-4o-transcribe", { reasoning: false }),
			openaiModel("gpt-4o-mini-tts", { reasoning: false }),
		])
		expect(models).toHaveLength(4)
		for (const model of models) {
			expect(model.api).toBeUndefined()
			expect(model.thinkingLevelMap).toBeUndefined()
		}
	})

	it("does not set a thinkingLevelMap on non-reasoning gated models", () => {
		const models = openaiProviderModels([openaiModel("gpt-4o", { reasoning: false })])
		expect(models[0]?.thinkingLevelMap).toBeUndefined()
	})

	it("keeps the OpenAI legacy tail and non-chat models on openai-completions", () => {
		const models = openaiProviderModels([
			openaiModel("gpt-3.5-turbo", { reasoning: false }),
			openaiModel("gpt-4", { reasoning: false }),
			openaiModel("gpt-4-turbo-2024-04-09", { reasoning: false }),
			openaiModel("gpt-audio", { reasoning: false }),
			openaiModel("text-embedding-3-small", { reasoning: false }),
			openaiModel("gpt-5-search-api"),
		])
		expect(models).toHaveLength(6)
		for (const model of models) {
			expect(model.api).toBeUndefined()
			expect(model.thinkingLevelMap).toBeUndefined()
		}
	})

	it("leaves per-model baseUrl unset so gated models inherit the provider's /openai/v1 base", () => {
		const models = openaiProviderModels([openaiModel("gpt-5.6")])
		expect(models[0]?.baseUrl).toBeUndefined()
	})

	it("warns when an OpenAI slug matches neither routing table (catalog lint)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const models = openaiProviderModels([
			openaiModel("o5"),
			openaiModel("gpt-3.5-turbo", { reasoning: false }),
			openaiModel("gpt-4o", { reasoning: false }),
		])
		expect(models).toHaveLength(3)
		// Unknown slug still routes via chat completions — the lint only warns.
		expect(models.find((m) => m.id === "o5")?.api).toBeUndefined()
		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]?.[0]).toContain("'o5'")
	})

	it("does not touch non-openai providers", () => {
		const { providers } = buildModelsConfig([KIMI, SONNET_46] as never, "https://example.invalid")
		const kimi = providers["kimchi-dev/ai-enabler"]?.models ?? []
		const claude = providers["kimchi-dev/anthropic"]?.models ?? []
		for (const model of [...kimi, ...claude]) {
			expect(model.api).toBeUndefined()
		}
	})
})
