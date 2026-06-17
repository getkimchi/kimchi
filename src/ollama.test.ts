/**
 * Unit tests for src/ollama.ts.
 *
 * Covers the public surface of the Ollama provider module:
 *  - /api/tags and /api/show parsing (empty / single / multi / vision / tools / reasoning)
 *  - tier heuristic boundaries (parameter_size → light/standard/heavy)
 *  - PiModelConfig conversion (cost, modalities, reasoning flag)
 *  - models.json merge preserving existing custom providers
 *  - injectOllamaProvider idempotency and silent offline fallback
 *  - role pool augmentation (explorer/reviewer/builder only, never orchestrator, dedup)
 *  - resolveOllamaHost env-var precedence
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ModelRoles } from "./extensions/orchestration/model-roles.js"
import type { PiModelConfig } from "./models.js"
import type { OllamaModel } from "./ollama.js"
import {
	augmentModelRolesWithOllama,
	injectOllamaProvider,
	ollamaModelTier,
	ollamaToModelConfig,
	probeOllamaModels,
	readOllamaModelMetadata,
	readOllamaModelsFromConfig,
	resolveOllamaHost,
} from "./ollama.js"

/* -------------------------------------------------------------------------- */
/*  Test fixtures                                                             */
/* -------------------------------------------------------------------------- */

function makeTagsEntry(
	overrides: Partial<{
		name: string
		model: string
		details: Record<string, unknown>
		capabilities: string[]
	}>,
): Record<string, unknown> {
	return {
		name: overrides.name ?? "test-model:latest",
		...(overrides.model && { model: overrides.model }),
		...(overrides.details && { details: overrides.details }),
		...(overrides.capabilities && { capabilities: overrides.capabilities }),
	}
}

function makeTagsResponse(entries: Array<Record<string, unknown>>): { ok: true; json: () => Promise<unknown> } {
	return {
		ok: true,
		json: async () => ({ models: entries }),
	}
}

function makeShowResponse(
	modelInfo: Record<string, unknown>,
	capabilities?: string[],
): {
	ok: true
	json: () => Promise<unknown>
} {
	return {
		ok: true,
		json: async () => ({ model_info: modelInfo, ...(capabilities && { capabilities }) }),
	}
}

function okJson(value: unknown): { ok: true; json: () => Promise<unknown> } {
	return { ok: true, json: async () => value }
}

function notFoundJson(): { ok: false; status: number; json: () => Promise<unknown> } {
	return { ok: false, status: 404, json: async () => ({}) }
}

function makeFetchMock(responses: Array<(url: string, init?: RequestInit) => unknown>): typeof fetch {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const urlStr = typeof url === "string" ? url : url.toString()
		for (const responder of responses) {
			const result = responder(urlStr, init)
			if (result) return result as Response
		}
		// Default: return a 404 for any unhandled URL
		return new Response("not found", { status: 404 })
	}) as unknown as typeof fetch
}

/* -------------------------------------------------------------------------- */
/*  probeOllamaModels — /api/tags + /api/show parsing                         */
/* -------------------------------------------------------------------------- */

describe("probeOllamaModels — /api/tags parsing", () => {
	it("returns [] when /api/tags is unreachable (silent offline fallback)", async () => {
		const failingFetch = vi.fn(async () => {
			throw new TypeError("fetch failed: ECONNREFUSED")
		}) as unknown as typeof fetch

		const models = await probeOllamaModels("http://localhost:11434", { fetch: failingFetch })
		expect(models).toEqual([])
	})

	it("returns [] when /api/tags responds with non-2xx", async () => {
		const fetchImpl = makeFetchMock([(url) => (url.endsWith("/api/tags") ? notFoundJson() : null)])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models).toEqual([])
	})

	it("returns [] when /api/tags returns malformed JSON", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			json: async () => {
				throw new SyntaxError("Unexpected token")
			},
		})) as unknown as typeof fetch
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models).toEqual([])
	})

	it("returns [] for an empty model list", async () => {
		const fetchImpl = makeFetchMock([(url) => (url.endsWith("/api/tags") ? okJson({ models: [] }) : null)])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models).toEqual([])
	})

	it("returns [] when /api/tags has no models array at all", async () => {
		const fetchImpl = makeFetchMock([(url) => (url.endsWith("/api/tags") ? okJson({}) : null)])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models).toEqual([])
	})

	it("parses a single-model response", async () => {
		const entry = makeTagsEntry({
			name: "llama3:8b",
			details: { parameter_size: "8B", family: "llama", quantization_level: "Q4_K_M" },
			capabilities: ["completion"],
		})
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) => (url.endsWith("/api/show") ? makeShowResponse({ "llama.context_length": 8192 }) : null),
		])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models).toHaveLength(1)
		expect(models[0]).toMatchObject({
			id: "llama3:8b",
			name: "llama3:8b",
			parameterSize: 8,
			contextWindow: 8192,
			inputModalities: ["text"],
			reasoning: false,
			family: "llama",
			quantization: "Q4_K_M",
		})
	})

	it("parses a multi-model response, preserving order", async () => {
		const entries = [
			makeTagsEntry({
				name: "model-a:7b",
				details: { parameter_size: "7B", family: "qwen2" },
				capabilities: ["completion"],
			}),
			makeTagsEntry({
				name: "model-b:30b",
				details: { parameter_size: "30B", family: "qwen2" },
				capabilities: ["completion"],
			}),
			makeTagsEntry({
				name: "model-c:70b",
				details: { parameter_size: "70B", family: "llama" },
				capabilities: ["completion"],
			}),
		]
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse(entries) : null),
			(url) => (url.endsWith("/api/show") ? makeShowResponse({ "llama.context_length": 4096 }) : null),
		])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models.map((m) => m.id)).toEqual(["model-a:7b", "model-b:30b", "model-c:70b"])
		expect(models.map((m) => m.parameterSize)).toEqual([7, 30, 70])
	})

	it("skips entries with no name or model field", async () => {
		const entries = [
			{ details: { parameter_size: "8B" }, capabilities: [] },
			makeTagsEntry({ name: "valid:8b", details: { parameter_size: "8B" } }),
		]
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse(entries) : null),
			(url) => (url.endsWith("/api/show") ? makeShowResponse({ "x.context_length": 4096 }) : null),
		])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models).toHaveLength(1)
		expect(models[0].id).toBe("valid:8b")
	})

	it("falls back to default context window when /api/show has no context_length", async () => {
		const entry = makeTagsEntry({ name: "no-context:8b", details: { parameter_size: "8B" } })
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) => (url.endsWith("/api/show") ? makeShowResponse({}) : null),
		])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models[0].contextWindow).toBe(32768) // DEFAULT_CONTEXT_WINDOW
	})

	it("keeps the entry when /api/show fails (per-model failure is non-fatal)", async () => {
		const entry = makeTagsEntry({
			name: "robust:8b",
			details: { parameter_size: "8B" },
			capabilities: ["completion"],
		})
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString()
			if (urlStr.endsWith("/api/tags")) {
				return { ok: true, json: async () => ({ models: [entry] }) } as unknown as Response
			}
			throw new Error("network glitch on /api/show")
		}) as unknown as typeof fetch

		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models).toHaveLength(1)
		expect(models[0].id).toBe("robust:8b")
	})

	it("extracts context from arch-specific model_info keys (qwen2.context_length)", async () => {
		const entry = makeTagsEntry({
			name: "qwen:7b",
			details: { parameter_size: "7B" },
			capabilities: ["completion"],
		})
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) =>
				url.endsWith("/api/show")
					? makeShowResponse({
							"qwen2.context_length": 32768,
							"qwen2.embedding_length": 3584,
						})
					: null,
		])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models[0].contextWindow).toBe(32768)
	})

	it("strips trailing slashes from the host before probing", async () => {
		const fetchImpl = vi.fn(async (url: string | URL | Request) => {
			const urlStr = typeof url === "string" ? url : url.toString()
			// Should hit exactly http://localhost:11434/api/tags (no double slash)
			expect(urlStr).toBe("http://localhost:11434/api/tags")
			return { ok: true, json: async () => ({ models: [] }) } as unknown as Response
		}) as unknown as typeof fetch
		await probeOllamaModels("http://localhost:11434/", { fetch: fetchImpl })
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})
})

describe("probeOllamaModels — /api/show capability enrichment", () => {
	it("marks vision capability on input modalities", async () => {
		const entry = makeTagsEntry({
			name: "vision-model:latest",
			details: { parameter_size: "13B" },
			capabilities: ["completion", "vision"],
		})
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) =>
				url.endsWith("/api/show") ? makeShowResponse({ "llama.context_length": 4096 }, ["completion", "vision"]) : null,
		])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models[0].inputModalities).toEqual(["text", "image"])
	})

	it("marks tools capability without changing modalities", async () => {
		const entry = makeTagsEntry({
			name: "tool-model:latest",
			details: { parameter_size: "8B" },
			capabilities: ["completion", "tools"],
		})
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) =>
				url.endsWith("/api/show") ? makeShowResponse({ "llama.context_length": 8192 }, ["completion", "tools"]) : null,
		])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models[0].inputModalities).toEqual(["text"])
		expect(models[0].reasoning).toBe(false)
	})

	it("marks reasoning capability (thinking) when present", async () => {
		const entry = makeTagsEntry({
			name: "reasoner:latest",
			details: { parameter_size: "8B" },
			capabilities: ["completion", "thinking"],
		})
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) =>
				url.endsWith("/api/show")
					? makeShowResponse({ "qwen2.context_length": 16384 }, ["completion", "thinking"])
					: null,
		])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models[0].reasoning).toBe(true)
	})

	it("handles a model with vision + tools + reasoning combined", async () => {
		const entry = makeTagsEntry({
			name: "kitchen-sink:latest",
			details: { parameter_size: "70B" },
			capabilities: ["completion", "vision", "tools", "thinking"],
		})
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) =>
				url.endsWith("/api/show")
					? makeShowResponse({ "llama.context_length": 131072 }, ["completion", "vision", "tools", "thinking"])
					: null,
		])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models[0]).toMatchObject({
			inputModalities: ["text", "image"],
			reasoning: true,
			contextWindow: 131072,
		})
	})

	it("falls back to tags-level capabilities when /api/show omits them", async () => {
		const entry = makeTagsEntry({
			name: "fallback-caps:8b",
			details: { parameter_size: "8B" },
			capabilities: ["completion", "vision"],
		})
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			// /api/show returns 404 → use the tags-level capabilities
			(url) => (url.endsWith("/api/show") ? notFoundJson() : null),
		])
		const models = await probeOllamaModels("http://localhost:11434", { fetch: fetchImpl })
		expect(models[0].inputModalities).toEqual(["text", "image"])
	})
})

/* -------------------------------------------------------------------------- */
/*  ollamaModelTier — boundary cases                                          */
/* -------------------------------------------------------------------------- */

describe("ollamaModelTier — parameter_size boundaries", () => {
	function modelWith(paramsB: number | null): OllamaModel {
		return {
			id: "test",
			name: "test",
			parameterSize: paramsB,
			contextWindow: 8192,
			inputModalities: ["text"],
			reasoning: false,
			family: "test",
			quantization: "Q4_K_M",
		}
	}

	it("classifies < 8B as light", () => {
		expect(ollamaModelTier(modelWith(7))).toBe("light")
		expect(ollamaModelTier(modelWith(1))).toBe("light")
		expect(ollamaModelTier(modelWith(0.5))).toBe("light")
	})

	it("classifies exactly 8B as standard", () => {
		expect(ollamaModelTier(modelWith(8))).toBe("standard")
	})

	it("classifies 8B < x < 30B as standard", () => {
		expect(ollamaModelTier(modelWith(13))).toBe("standard")
		expect(ollamaModelTier(modelWith(14.7))).toBe("standard")
		expect(ollamaModelTier(modelWith(29.9))).toBe("standard")
	})

	it("classifies exactly 30B as heavy", () => {
		expect(ollamaModelTier(modelWith(30))).toBe("heavy")
	})

	it("classifies 30.0B as heavy (decimal format)", () => {
		expect(ollamaModelTier(modelWith(30.0))).toBe("heavy")
	})

	it("classifies > 30B as heavy", () => {
		expect(ollamaModelTier(modelWith(70))).toBe("heavy")
		expect(ollamaModelTier(modelWith(405))).toBe("heavy")
	})

	it("defaults unknown parameter size to standard", () => {
		expect(ollamaModelTier(modelWith(null))).toBe("standard")
	})
})

/* -------------------------------------------------------------------------- */
/*  ollamaToModelConfig — config shape                                        */
/* -------------------------------------------------------------------------- */

describe("ollamaToModelConfig", () => {
	it("produces zero cost across the board (local inference)", () => {
		const config = ollamaToModelConfig({
			id: "llama3:8b",
			name: "llama3:8b",
			parameterSize: 8,
			contextWindow: 8192,
			inputModalities: ["text"],
			reasoning: false,
			family: "llama",
			quantization: "Q4_K_M",
		})
		expect(config.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
	})

	it("sets provider='ollama'", () => {
		const config = ollamaToModelConfig({
			id: "x",
			name: "x",
			parameterSize: 8,
			contextWindow: 4096,
			inputModalities: ["text"],
			reasoning: false,
			family: "x",
			quantization: "Q4_0",
		})
		expect(config.provider).toBe("ollama")
	})

	it("caps maxTokens at 8192 even when context is larger", () => {
		const config = ollamaToModelConfig({
			id: "big",
			name: "big",
			parameterSize: 70,
			contextWindow: 131072,
			inputModalities: ["text"],
			reasoning: false,
			family: "llama",
			quantization: "Q4_K_M",
		})
		expect(config.maxTokens).toBe(8192)
	})

	it("preserves reasoning and input modalities from the Ollama model", () => {
		const config = ollamaToModelConfig({
			id: "vision",
			name: "vision",
			parameterSize: 13,
			contextWindow: 16384,
			inputModalities: ["text", "image"],
			reasoning: true,
			family: "llama",
			quantization: "Q4_K_M",
		})
		expect(config.reasoning).toBe(true)
		expect(config.input).toEqual(["text", "image"])
	})
})

/* -------------------------------------------------------------------------- */
/*  injectOllamaProvider — file I/O                                           */
/* -------------------------------------------------------------------------- */

describe("injectOllamaProvider — models.json merge", () => {
	let tmpDir: string
	let modelsJsonPath: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-ollama-test-"))
		modelsJsonPath = join(tmpDir, "models.json")
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	function writeModelsJson(content: object): void {
		writeFileSync(modelsJsonPath, JSON.stringify(content, null, "\t"), "utf-8")
	}

	function readModelsJson(): Record<string, unknown> {
		return JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
	}

	it("writes the ollama provider when probe succeeds and file exists", async () => {
		writeModelsJson({
			providers: {
				"kimchi-dev": {
					api: "openai-completions",
					baseUrl: "https://llm.kimchi.dev/openai/v1",
					apiKey: "$KIMCHI_API_KEY",
					models: [],
				},
			},
		})
		const entry = makeTagsEntry({
			name: "llama3:8b",
			details: { parameter_size: "8B", family: "llama" },
			capabilities: ["completion"],
		})
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) => (url.endsWith("/api/show") ? makeShowResponse({ "llama.context_length": 8192 }) : null),
		])

		await injectOllamaProvider(modelsJsonPath, "http://localhost:11434", { fetch: fetchImpl })

		const config = readModelsJson()
		expect(config.providers).toHaveProperty("ollama")
		const ollama = (
			config.providers as Record<string, { api: string; baseUrl: string; apiKey: string; models: unknown[] }>
		).ollama
		expect(ollama.api).toBe("openai-completions")
		expect(ollama.baseUrl).toBe("http://localhost:11434/v1")
		expect(ollama.apiKey).toBe("ollama")
		expect(ollama.models).toHaveLength(1)
	})

	it("preserves kimchi-dev, kimchi-experimental, and custom providers", async () => {
		writeModelsJson({
			providers: {
				"kimchi-dev": { models: [{ id: "kimchi-1" }] },
				"kimchi-experimental": { models: [{ id: "exp-1" }] },
				"my-custom-provider": {
					api: "openai-completions",
					baseUrl: "https://custom.example/v1",
					apiKey: "secret",
					models: [{ id: "custom-1" }],
				},
			},
		})
		const entry = makeTagsEntry({ name: "llama3:8b", details: { parameter_size: "8B" } })
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) => (url.endsWith("/api/show") ? makeShowResponse({ "llama.context_length": 4096 }) : null),
		])

		await injectOllamaProvider(modelsJsonPath, "http://localhost:11434", { fetch: fetchImpl })

		const config = readModelsJson()
		const providers = config.providers as Record<string, { models: unknown[] }>
		expect(providers["kimchi-dev"].models).toEqual([{ id: "kimchi-1" }])
		expect(providers["kimchi-experimental"].models).toEqual([{ id: "exp-1" }])
		expect(providers["my-custom-provider"].models).toEqual([{ id: "custom-1" }])
		expect(providers.ollama).toBeDefined()
	})

	it("is a no-op when probe returns no models", async () => {
		writeModelsJson({
			providers: {
				"kimchi-dev": { models: [{ id: "kimchi-1" }] },
			},
		})
		const fetchImpl = makeFetchMock([(url) => (url.endsWith("/api/tags") ? okJson({ models: [] }) : null)])

		await injectOllamaProvider(modelsJsonPath, "http://localhost:11434", { fetch: fetchImpl })

		const config = readModelsJson()
		const providers = config.providers as Record<string, unknown>
		expect(providers.ollama).toBeUndefined()
		expect(providers["kimchi-dev"]).toBeDefined()
	})

	it("is a silent no-op when models.json is missing (no createIfMissing)", async () => {
		const missingPath = join(tmpDir, "does-not-exist.json")
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([makeTagsEntry({ name: "x" })]) : null),
		])

		await expect(
			injectOllamaProvider(missingPath, "http://localhost:11434", { fetch: fetchImpl }),
		).resolves.toBeUndefined()
	})

	it("creates the file when models.json is missing and createIfMissing=true", async () => {
		const missingPath = join(tmpDir, "fresh.json")
		const entry = makeTagsEntry({ name: "llama3:8b", details: { parameter_size: "8B" } })
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) => (url.endsWith("/api/show") ? makeShowResponse({ "llama.context_length": 8192 }) : null),
		])

		await injectOllamaProvider(missingPath, "http://localhost:11434", { fetch: fetchImpl, createIfMissing: true })

		const config = JSON.parse(readFileSync(missingPath, "utf-8"))
		expect(config.providers).toHaveProperty("ollama")
	})

	it("is idempotent — second call produces a byte-identical models.json", async () => {
		writeModelsJson({
			providers: {
				"kimchi-dev": { models: [{ id: "kimchi-1" }] },
			},
		})
		const entry = makeTagsEntry({ name: "llama3:8b", details: { parameter_size: "8B" } })
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) => (url.endsWith("/api/show") ? makeShowResponse({ "llama.context_length": 8192 }) : null),
		])

		await injectOllamaProvider(modelsJsonPath, "http://localhost:11434", { fetch: fetchImpl })
		const firstContent = readFileSync(modelsJsonPath, "utf-8")

		await injectOllamaProvider(modelsJsonPath, "http://localhost:11434", { fetch: fetchImpl })
		const secondContent = readFileSync(modelsJsonPath, "utf-8")

		expect(secondContent).toBe(firstContent)
	})

	it("replaces stale ollama provider entries on re-injection (latest probe wins)", async () => {
		writeModelsJson({
			providers: {
				"kimchi-dev": { models: [] },
				ollama: {
					api: "openai-completions",
					baseUrl: "http://localhost:11434/v1",
					apiKey: "ollama",
					models: [{ id: "old-model:7b", name: "old-model:7b" }],
				},
			},
		})

		const entry = makeTagsEntry({ name: "new-model:8b", details: { parameter_size: "8B" } })
		const fetchImpl = makeFetchMock([
			(url) => (url.endsWith("/api/tags") ? makeTagsResponse([entry]) : null),
			(url) => (url.endsWith("/api/show") ? makeShowResponse({ "llama.context_length": 4096 }) : null),
		])

		await injectOllamaProvider(modelsJsonPath, "http://localhost:11434", { fetch: fetchImpl })

		const config = readModelsJson()
		const ollama = (config.providers as { ollama: { models: Array<{ id: string }> } }).ollama
		expect(ollama.models).toHaveLength(1)
		expect(ollama.models[0].id).toBe("new-model:8b")
	})

	it("swallows thrown errors silently (does not propagate)", async () => {
		writeModelsJson({ providers: { "kimchi-dev": { models: [] } } })

		const failingFetch = vi.fn(async () => {
			throw new Error("unexpected")
		}) as unknown as typeof fetch

		await expect(
			injectOllamaProvider(modelsJsonPath, "http://localhost:11434", { fetch: failingFetch }),
		).resolves.toBeUndefined()

		// File untouched — no provider was added
		const config = readModelsJson()
		expect(config.providers).not.toHaveProperty("ollama")
	})
})

/* -------------------------------------------------------------------------- */
/*  readOllamaModelsFromConfig + readOllamaModelMetadata                       */
/* -------------------------------------------------------------------------- */

describe("readOllamaModelsFromConfig + readOllamaModelMetadata", () => {
	let tmpDir: string
	let modelsJsonPath: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-ollama-read-"))
		modelsJsonPath = join(tmpDir, "models.json")
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("returns [] when the file does not exist", () => {
		expect(readOllamaModelsFromConfig(join(tmpDir, "missing.json"))).toEqual([])
		expect(readOllamaModelMetadata(join(tmpDir, "missing.json"))).toEqual([])
	})

	it("returns [] when the file is malformed", () => {
		writeFileSync(modelsJsonPath, "{not valid json", "utf-8")
		expect(readOllamaModelsFromConfig(modelsJsonPath)).toEqual([])
	})

	it("returns [] when the file has no ollama provider", () => {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers: { "kimchi-dev": { models: [] } } }), "utf-8")
		expect(readOllamaModelsFromConfig(modelsJsonPath)).toEqual([])
	})

	it("round-trips PiModelConfig fields", () => {
		const config: PiModelConfig = {
			id: "llama3:8b",
			name: "llama3:8b",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 32768,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			provider: "ollama",
		}
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					ollama: {
						api: "openai-completions",
						baseUrl: "http://localhost:11434/v1",
						apiKey: "ollama",
						models: [config],
					},
				},
			}),
			"utf-8",
		)
		expect(readOllamaModelsFromConfig(modelsJsonPath)).toEqual([config])
	})

	it("readOllamaModelMetadata maps to ModelMetadata shape", () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					ollama: {
						models: [
							{
								id: "llama3:8b",
								name: "llama3:8b",
								reasoning: true,
								input: ["text", "image"],
								contextWindow: 32768,
								maxTokens: 8192,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								provider: "ollama",
							},
						],
					},
				},
			}),
			"utf-8",
		)
		const metadata = readOllamaModelMetadata(modelsJsonPath)
		expect(metadata).toEqual([
			{
				slug: "llama3:8b",
				display_name: "llama3:8b",
				provider: "ollama",
				reasoning: true,
				input_modalities: ["text", "image"],
				is_serverless: true,
				limits: { context_window: 32768, max_output_tokens: 8192 },
			},
		])
	})

	it("readOllamaModelMetadata defaults provider to 'ollama' when missing on the config row", () => {
		writeFileSync(
			modelsJsonPath,
			JSON.stringify({
				providers: {
					ollama: {
						models: [
							{
								id: "x",
								name: "x",
								reasoning: false,
								input: ["text"],
								contextWindow: 4096,
								maxTokens: 4096,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								// no provider field on purpose
							},
						],
					},
				},
			}),
			"utf-8",
		)
		const metadata = readOllamaModelMetadata(modelsJsonPath)
		expect(metadata[0].provider).toBe("ollama")
	})
})

/* -------------------------------------------------------------------------- */
/*  augmentModelRolesWithOllama — role pool rules                             */
/* -------------------------------------------------------------------------- */

describe("augmentModelRolesWithOllama — role pool augmentation", () => {
	const baseRoles: ModelRoles = {
		orchestrator: "anthropic/claude-opus-4",
		planner: "anthropic/claude-sonnet-4",
		judge: "anthropic/claude-sonnet-4",
		builder: ["anthropic/claude-sonnet-4", "openai/gpt-5"],
		reviewer: "anthropic/claude-sonnet-4",
		explorer: ["openai/gpt-5-mini"],
	}

	const ollamaModels: OllamaModel[] = [
		{
			id: "llama3:8b",
			name: "llama3:8b",
			parameterSize: 8,
			contextWindow: 8192,
			inputModalities: ["text"],
			reasoning: false,
			family: "llama",
			quantization: "Q4_K_M",
		},
		{
			id: "qwen2:70b",
			name: "qwen2:70b",
			parameterSize: 70,
			contextWindow: 32768,
			inputModalities: ["text"],
			reasoning: false,
			family: "qwen2",
			quantization: "Q4_K_M",
		},
	]

	it("adds each model to explorer, reviewer, and builder", () => {
		const result = augmentModelRolesWithOllama(baseRoles, ollamaModels)
		expect(result.explorer).toContain("ollama/llama3:8b")
		expect(result.explorer).toContain("ollama/qwen2:70b")
		expect(result.reviewer).toContain("ollama/llama3:8b")
		expect(result.reviewer).toContain("ollama/qwen2:70b")
		expect(result.builder).toContain("ollama/llama3:8b")
		expect(result.builder).toContain("ollama/qwen2:70b")
	})

	it("never touches orchestrator, planner, or judge", () => {
		const result = augmentModelRolesWithOllama(baseRoles, ollamaModels)
		expect(result.orchestrator).toBe("anthropic/claude-opus-4")
		expect(result.planner).toBe("anthropic/claude-sonnet-4")
		expect(result.judge).toBe("anthropic/claude-sonnet-4")
	})

	it("does not mutate the input roles object", () => {
		const original = JSON.parse(JSON.stringify(baseRoles))
		augmentModelRolesWithOllama(baseRoles, ollamaModels)
		expect(baseRoles).toEqual(original)
	})

	it("returns the same roles reference when models array is empty", () => {
		const result = augmentModelRolesWithOllama(baseRoles, [])
		expect(result).toBe(baseRoles)
	})

	it("dedupes when an ollama/<id> ref is already present in the pool", () => {
		const rolesWithOllamaAlready: ModelRoles = {
			...baseRoles,
			builder: ["anthropic/claude-sonnet-4", "ollama/llama3:8b"],
		}
		const result = augmentModelRolesWithOllama(rolesWithOllamaAlready, [ollamaModels[0]])
		// llama3:8b is already present — should not be duplicated
		const builderArr = Array.isArray(result.builder) ? result.builder : [result.builder]
		const occurrences = builderArr.filter((r) => r === "ollama/llama3:8b").length
		expect(occurrences).toBe(1)
	})

	it("promotes a string assignment to an array when a second model is appended", () => {
		const singleModelRoles: ModelRoles = {
			...baseRoles,
			reviewer: "anthropic/claude-sonnet-4",
		}
		const result = augmentModelRolesWithOllama(singleModelRoles, [ollamaModels[0]])
		expect(Array.isArray(result.reviewer)).toBe(true)
		expect(result.reviewer).toEqual(["anthropic/claude-sonnet-4", "ollama/llama3:8b"])
	})

	it("keeps the single-string form when a second model is appended to a single-element array", () => {
		const singleElementRoles: ModelRoles = {
			...baseRoles,
			explorer: ["openai/gpt-5-mini"],
		}
		const result = augmentModelRolesWithOllama(singleElementRoles, [ollamaModels[0]])
		expect(Array.isArray(result.explorer)).toBe(true)
		expect(result.explorer as string[]).toEqual(["openai/gpt-5-mini", "ollama/llama3:8b"])
	})

	it("accepts PiModelConfig entries (the cli.ts call shape)", () => {
		const piConfigs: PiModelConfig[] = [
			{
				id: "llama3:8b",
				name: "llama3:8b",
				reasoning: false,
				input: ["text"],
				contextWindow: 8192,
				maxTokens: 8192,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				provider: "ollama",
			},
		]
		const result = augmentModelRolesWithOllama(baseRoles, piConfigs)
		expect(result.builder).toContain("ollama/llama3:8b")
	})
})

/* -------------------------------------------------------------------------- */
/*  resolveOllamaHost — env-var precedence                                    */
/* -------------------------------------------------------------------------- */

describe("resolveOllamaHost — environment variable precedence", () => {
	const originalEnv = { ...process.env }

	beforeEach(() => {
		process.env.OLLAMA_HOST = ""
		process.env.KIMCHI_OLLAMA_HOST = ""
	})

	afterEach(() => {
		process.env = { ...originalEnv }
	})

	it("defaults to http://localhost:11434 when no env is set", () => {
		expect(resolveOllamaHost()).toBe("http://localhost:11434")
	})

	it("uses $OLLAMA_HOST when set", () => {
		process.env.OLLAMA_HOST = "http://gpu-box.lan:11434"
		expect(resolveOllamaHost()).toBe("http://gpu-box.lan:11434")
	})

	it("falls back to $KIMCHI_OLLAMA_HOST when $OLLAMA_HOST is unset", () => {
		process.env.KIMCHI_OLLAMA_HOST = "http://kimchi-host:11434"
		expect(resolveOllamaHost()).toBe("http://kimchi-host:11434")
	})

	it("$OLLAMA_HOST wins over $KIMCHI_OLLAMA_HOST", () => {
		process.env.OLLAMA_HOST = "http://primary:11434"
		process.env.KIMCHI_OLLAMA_HOST = "http://fallback:11434"
		expect(resolveOllamaHost()).toBe("http://primary:11434")
	})

	it("strips trailing slashes", () => {
		process.env.OLLAMA_HOST = "http://localhost:11434/"
		expect(resolveOllamaHost()).toBe("http://localhost:11434")
	})

	it("treats whitespace-only env as absent", () => {
		process.env.OLLAMA_HOST = "   "
		expect(resolveOllamaHost()).toBe("http://localhost:11434")
	})
})
