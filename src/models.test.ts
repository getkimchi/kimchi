import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { updateModelsConfig } from "./models.js"

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

describe("updateModelsConfig", () => {
	let tempDir: string
	let modelsJsonPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-models-test-"))
		modelsJsonPath = join(tempDir, "models.json")
		vi.stubGlobal("fetch", vi.fn())
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	it("maps each metadata field into the pi-mono model config", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
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

	it("sets Anthropic compat flags for anthropic models", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [SONNET_46] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].models[0].compat).toEqual({
			supportsReasoningEffort: false,
			cacheControlFormat: "anthropic",
		})
	})

	it("omits compat for non-anthropic models", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].models[0]).not.toHaveProperty("compat")
	})

	it("puts AI-Enabler models first and preserves API order for others, all under kimchi-dev", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [OPUS_46, GLM, SONNET_46, KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(Object.keys(config.providers)).toEqual(["kimchi-dev"])
		const ids = config.providers["kimchi-dev"].models.map((m: { id: string }) => m.id)
		expect(ids).toEqual(["glm-5-fp8", "kimi-k2.5", "claude-opus-4-6", "claude-sonnet-4-6"])
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

	it("returns discovered metadata when fetch succeeds", async () => {
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI, GLM] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		expect(result.models.map((m) => m.slug)).toEqual(["kimi-k2.5", "glm-5-fp8"])
	})

	it("preserves user-added providers when updating models.json", async () => {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: { custom: { models: [] } } }))
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [KIMI] }),
		} as Response)

		await updateModelsConfig(modelsJsonPath, "test-key")

		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].models.map((m: { id: string }) => m.id)).toEqual(["kimi-k2.5"])
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
						apiKey: "KIMCHI_API_KEY",
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

	it("throws on fetch failure when no cached config exists", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new Error("network error"))
		await expect(updateModelsConfig(modelsJsonPath, "test-key")).rejects.toThrow("network error")
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

		expect(result.models.map((m) => m.slug)).toEqual(["kimi-k2.5", "claude-sonnet-4-6", "gpt-4"])
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
			status: "sunset",
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
			status: "sunset",
		}
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [sunsetModel] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining("All models from the API are sunset"))
		expect(result.models).toHaveLength(0)
		const config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
		expect(config.providers["kimchi-dev"].models).toHaveLength(0)
		consoleWarnSpy.mockRestore()
	})

	it("treats models without status field as active (backward compatibility)", async () => {
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
			status: "deprecated",
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

	it("preserves replacement field on deprecated/sunset models in returned metadata", async () => {
		const deprecatedWithReplacement = {
			slug: "old-model",
			display_name: "Old Model",
			provider: "ai-enabler",
			reasoning: false,
			input_modalities: ["text"],
			is_serverless: true,
			limits: { context_window: 100_000, max_output_tokens: 4096 },
			status: "deprecated",
			replacement: "new-model",
		}
		vi.mocked(fetch).mockResolvedValueOnce({
			ok: true,
			json: async () => ({ models: [deprecatedWithReplacement] }),
		} as Response)

		const result = await updateModelsConfig(modelsJsonPath, "test-key")

		const model = result.models.find((m) => m.slug === "old-model")
		expect(model?.status).toBe("deprecated")
		expect(model?.replacement).toBe("new-model")
	})
})
