import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { KimchiConfig } from "../../config.js"
import {
	buildMemoryConfig,
	createMemoryBackend,
	defaultMemoryDir,
	EXTRACTION_MODEL_PREFERENCES,
	historyDbPath,
	MEMORY_EMBEDDING_DIMS,
	MEMORY_EMBEDDING_MODEL,
	memoryDbPath,
	projectDbPath,
	resolveExtractionModel,
	tagEmbeddingRequests,
} from "./backend.js"

function testConfig(overrides: Partial<KimchiConfig> = {}): KimchiConfig {
	return {
		apiKey: "test-key",
		agentConfigDir: "/agent-config-dir",
		llmEndpoint: "https://gateway.test/openai/v1",
		customLlmEndpoint: undefined,
		maxToolResultChars: 10_000,
		mcpSearchLimit: 5,
		mcpSearch: {
			strategy: "bm25",
			bm25K1: 1.2,
			bm25B: 0.75,
			fieldWeights: { name: 6, description: 2, schemaKey: 1 },
		},
		onboarding: {},
		deviceId: "",
		...overrides,
	}
}

describe("buildMemoryConfig", () => {
	it("wires the gateway endpoints by default", () => {
		const config = buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())
		expect(config.embedder.provider).toBe("openai")
		expect(config.embedder.config.model).toBe(MEMORY_EMBEDDING_MODEL)
		expect(config.embedder.config.baseURL).toBe("https://gateway.test/openai/v1")
		expect(config.embedder.config.apiKey).toBe("test-key")
		expect(config.llm.provider).toBe("openai")
		expect(config.llm.config.model).toBe(EXTRACTION_MODEL_PREFERENCES[0])
		expect(config.llm.config.apiKey).toBe("test-key")
		expect(config.vectorStore.provider).toBe("memory")
		expect(config.vectorStore.config.dbPath).toBe("/tmp/mem.db")
	})

	it("uses the user-configured llmEndpoint when set", () => {
		const config = buildMemoryConfig(
			{ dbPath: "/tmp/mem.db" },
			testConfig({ llmEndpoint: "https://private.test/v1", customLlmEndpoint: "https://private.test/v1" }),
		)
		expect(config.embedder.config.baseURL).toBe("https://private.test/v1")
		expect(config.llm.config.baseURL).toBe("https://private.test/v1")
	})

	it("endpoint overrides replace only their endpoint", () => {
		const config = buildMemoryConfig(
			{
				dbPath: "/tmp/mem.db",
				embedder: { baseURL: "http://127.0.0.1:9/v1", apiKey: "stub-key", model: "stub-model" },
			},
			testConfig(),
		)
		expect(config.embedder.config.baseURL).toBe("http://127.0.0.1:9/v1")
		expect(config.embedder.config.apiKey).toBe("stub-key")
		expect(config.embedder.config.model).toBe("stub-model")
		// LLM untouched — still gateway-wired.
		expect(config.llm.config.baseURL).toBe("https://gateway.test/openai/v1")
		expect(config.llm.config.apiKey).toBe("test-key")
	})

	it("sets the embedding dimension the store schema requires", () => {
		const config = buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())
		expect(config.embedder.config.embeddingDims).toBe(MEMORY_EMBEDDING_DIMS)
		expect(config.vectorStore.config.dimension).toBe(MEMORY_EMBEDDING_DIMS)
	})

	it("pins the history store next to the vector store, never cwd", () => {
		const config = buildMemoryConfig({ dbPath: "/tmp/scope/memory.db" }, testConfig())
		expect(config.historyStore?.provider).toBe("sqlite")
		expect(config.historyStore?.config.historyDbPath).toBe("/tmp/scope/memory-history.db")
	})
})

describe("embedding endpoint env configuration", () => {
	const EMBEDDING_ENV_VARS = [
		"MEMORY_EMBEDDING_MODEL",
		"MEMORY_EMBEDDING_BASE_URL",
		"MEMORY_EMBEDDING_API_KEY",
		"MEMORY_EMBEDDING_DIMS",
		"OPENROUTER_API_KEY",
	] as const

	// Ambient env (e.g. a developer with OPENROUTER_API_KEY exported) must
	// not leak into these tests — each one starts from a clean slate.
	beforeEach(() => {
		for (const name of EMBEDDING_ENV_VARS) delete process.env[name]
	})
	afterEach(() => {
		for (const name of EMBEDDING_ENV_VARS) delete process.env[name]
	})

	it("custom base URL with explicit key uses both; the LLM stays on the gateway", () => {
		process.env.MEMORY_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1"
		process.env.MEMORY_EMBEDDING_API_KEY = "or-key"
		const config = buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())
		expect(config.embedder.config.baseURL).toBe("https://openrouter.ai/api/v1")
		expect(config.embedder.config.apiKey).toBe("or-key")
		expect(config.embedder.config.embeddingDims).toBe(MEMORY_EMBEDDING_DIMS)
		expect(config.llm.config.baseURL).toBe("https://gateway.test/openai/v1")
		expect(config.llm.config.apiKey).toBe("test-key")
	})

	it("custom base URL falls back to OPENROUTER_API_KEY", () => {
		process.env.MEMORY_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1"
		process.env.OPENROUTER_API_KEY = "or-key"
		const config = buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())
		expect(config.embedder.config.apiKey).toBe("or-key")
	})

	it("custom base URL with no key anywhere throws", () => {
		process.env.MEMORY_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1"
		expect(() => buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())).toThrow(
			/MEMORY_EMBEDDING_BASE_URL is set but no embedding API key/,
		)
	})

	it("a custom key without a custom base URL is ignored — gateway stays on gateway credentials", () => {
		process.env.MEMORY_EMBEDDING_API_KEY = "or-key"
		const config = buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())
		expect(config.embedder.config.baseURL).toBe("https://gateway.test/openai/v1")
		expect(config.embedder.config.apiKey).toBe("test-key")
	})

	it("model override applies in gateway mode", () => {
		process.env.MEMORY_EMBEDDING_MODEL = "text-embedding-3-large"
		const config = buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())
		expect(config.embedder.config.model).toBe("text-embedding-3-large")
		expect(config.embedder.config.baseURL).toBe("https://gateway.test/openai/v1")
		expect(config.embedder.config.apiKey).toBe("test-key")
	})

	it("dims override reaches the embedder and the vector store together", () => {
		process.env.MEMORY_EMBEDDING_DIMS = "3072"
		const config = buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())
		expect(config.embedder.config.embeddingDims).toBe(3072)
		expect(config.vectorStore.config.dimension).toBe(3072)
	})

	it("invalid dims throw a clear error", () => {
		process.env.MEMORY_EMBEDDING_DIMS = "not-a-number"
		expect(() => buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())).toThrow(
			/MEMORY_EMBEDDING_DIMS must be a positive integer/,
		)
	})

	it("programmatic overrides win over the env layer", () => {
		process.env.MEMORY_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1"
		process.env.MEMORY_EMBEDDING_API_KEY = "or-key"
		const config = buildMemoryConfig(
			{ dbPath: "/tmp/mem.db", embedder: { baseURL: "http://127.0.0.1:9/v1", apiKey: "stub-key" } },
			testConfig(),
		)
		expect(config.embedder.config.baseURL).toBe("http://127.0.0.1:9/v1")
		expect(config.embedder.config.apiKey).toBe("stub-key")
	})
})

describe("memory paths", () => {
	it("scopes databases under the kimchi memory dir", () => {
		expect(memoryDbPath("personal")).toBe(join(defaultMemoryDir(), "personal", "memory.db"))
		expect(defaultMemoryDir()).toBe(join(homedir(), ".config", "kimchi", "memory"))
	})

	it("rejects path-escaping scope ids", () => {
		expect(() => memoryDbPath("personal/../../evil")).toThrow(/invalid memory scope id/)
		expect(() => memoryDbPath("../evil")).toThrow(/invalid memory scope id/)
		expect(() => memoryDbPath("")).toThrow(/invalid memory scope id/)
	})

	it("derives the history db path from any db filename", () => {
		expect(historyDbPath("/a/b/memory.db")).toBe("/a/b/memory-history.db")
		expect(historyDbPath("/tmp/mem.db")).toBe("/tmp/mem-history.db")
		expect(historyDbPath("/tmp/nosuffix")).toBe("/tmp/nosuffix-history.db")
	})

	it("places project stores under projects/<owner>/<name>/", () => {
		expect(projectDbPath("castai/kimchi")).toBe(`${defaultMemoryDir()}/projects/castai/kimchi/memory.db`)
		expect(projectDbPath("myrepo")).toBe(`${defaultMemoryDir()}/projects/myrepo/memory.db`)
	})

	it("rejects invalid project scope ids", () => {
		expect(() => projectDbPath("../evil")).toThrow(/invalid project scope id/)
		expect(() => projectDbPath("a/b/c/d/e")).toThrow(/invalid project scope id/)
		expect(() => projectDbPath("")).toThrow(/invalid project scope id/)
	})
})

describe("createMemoryBackend", () => {
	it("rejects with a clear error when no API key resolves", async () => {
		await expect(createMemoryBackend({ dbPath: "/tmp/mem.db" }, testConfig({ apiKey: "" }))).rejects.toThrow(/API key/)
	})

	it("requires the Bun runtime when constructing under Node (vitest)", async () => {
		// The SQLite store constructs better-sqlite3, which resolves to
		// shims/better-sqlite3 — loadable under Node, but it can only
		// construct databases under Bun (bun:sqlite). This asserts the
		// clear-error contract; the real round-trip is backend.check.ts
		// under `pnpm run memory:check`.
		await expect(createMemoryBackend({ dbPath: "/tmp/mem.db" }, testConfig())).rejects.toThrow(
			/Bun runtime \(bun:sqlite\)/,
		)
	})

	describe("mem0 telemetry opt-out", () => {
		const restore = (prev: string | undefined): void => {
			if (prev === undefined) {
				delete process.env.MEM0_TELEMETRY
			} else {
				process.env.MEM0_TELEMETRY = prev
			}
		}

		it("disables mem0 PostHog telemetry by default (set before the module loads)", async () => {
			const prev = process.env.MEM0_TELEMETRY
			delete process.env.MEM0_TELEMETRY
			try {
				// Rejects under Node (Bun runtime guard), but the env guard is
				// applied before the dynamic import — the side effect we assert.
				await createMemoryBackend({ dbPath: "/tmp/mem.db" }, testConfig()).catch(() => {})
				expect(process.env.MEM0_TELEMETRY).toBe("false")
			} finally {
				restore(prev)
			}
		})

		it("preserves an explicit MEM0_TELEMETRY value", async () => {
			const prev = process.env.MEM0_TELEMETRY
			process.env.MEM0_TELEMETRY = "true"
			try {
				await createMemoryBackend({ dbPath: "/tmp/mem.db" }, testConfig()).catch(() => {})
				expect(process.env.MEM0_TELEMETRY).toBe("true")
			} finally {
				restore(prev)
			}
		})
	})
	describe("tagEmbeddingRequests", () => {
		it("tags gateway /embeddings requests only — custom endpoints stay untouched", async () => {
			const originalFetch = globalThis.fetch
			const seen: Array<{ url: string; body: Record<string, unknown> }> = []
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> })
				return new Response("{}", { status: 200 })
			})
			try {
				tagEmbeddingRequests("https://gw.test/v1")
				tagEmbeddingRequests("https://gw.test/v1") // idempotent — no double-wrap
				await globalThis.fetch("https://gw.test/v1/embeddings", {
					method: "POST",
					headers: { authorization: "Bearer k" },
					body: JSON.stringify({ input: ["text"], model: "text-embedding-3-small" }),
				})
				await globalThis.fetch("https://openrouter.ai/api/v1/embeddings", {
					method: "POST",
					headers: { authorization: "Bearer k" },
					body: JSON.stringify({ input: ["text"], model: "openai/text-embedding-3-small" }),
				})
				await globalThis.fetch("https://gw.test/v1/models", { method: "GET" })
				expect(seen).toHaveLength(3)
				// The gateway embeddings request got the tag
				expect(seen[0]?.body.tags).toEqual(["memory:embedding"])
				// A custom embedding endpoint must not receive the usage-tracking tag
				expect(seen[1]?.body.tags).toBeUndefined()
				// The models request is untouched
				expect(seen[2]?.body.tags).toBeUndefined()
			} finally {
				globalThis.fetch = originalFetch
			}
		})
	})
})

describe("resolveExtractionModel", () => {
	const gateway = { baseURL: "https://gw.test/v1", apiKey: "k" }
	const okModels = (ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })

	it("env override wins without querying the gateway", async () => {
		process.env.KIMCHI_MEMORY_EXTRACTION_MODEL = "custom-model"
		try {
			const fetchImpl = vi.fn()
			expect(await resolveExtractionModel(gateway, { fetchImpl })).toBe("custom-model")
			expect(fetchImpl).not.toHaveBeenCalled()
		} finally {
			delete process.env.KIMCHI_MEMORY_EXTRACTION_MODEL
		}
	})

	it("picks the first available preference (deepseek flash first)", async () => {
		const fetchImpl = vi
			.fn()
			.mockImplementation(() => Promise.resolve(okModels(["deepseek-v4-flash-0731", "glm-5.3-flash", "kimi-k3"])))
		expect(await resolveExtractionModel(gateway, { fetchImpl })).toBe("deepseek-v4-flash-0731")
	})

	it("falls through to glm flash when deepseek is unavailable", async () => {
		const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okModels(["glm-5.3-flash", "kimi-k3"])))
		expect(await resolveExtractionModel(gateway, { fetchImpl })).toBe("glm-5.3-flash")
	})

	it("falls through the preference order when earlier models are unavailable", async () => {
		const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okModels(["kimi-k3", "glm-5.3"])))
		expect(await resolveExtractionModel(gateway, { fetchImpl })).toBe("glm-5.3")
	})

	it("falls back to the top preference when the model list is unreachable", async () => {
		const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response("boom", { status: 503 })))
		expect(await resolveExtractionModel(gateway, { fetchImpl })).toBe(EXTRACTION_MODEL_PREFERENCES[0])
	})

	it("throws a clear error when no preference is available", async () => {
		const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okModels(["unrelated-model"])))
		await expect(resolveExtractionModel(gateway, { fetchImpl })).rejects.toThrow(/no extraction model available/)
	})
})

describe("resolveExtractionModel no longer calls the auto router", () => {
	const gateway = { baseURL: "https://gw.test/v1", apiKey: "k" }
	const okModels = (ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })

	it("resolves from the preference list without any /v1/route call", async () => {
		const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okModels(["glm-5.3-flash"])))
		expect(await resolveExtractionModel(gateway, { fetchImpl })).toBe("glm-5.3-flash")
		for (const [input] of fetchImpl.mock.calls) {
			expect(String(input)).not.toContain("/v1/route")
		}
	})
})
