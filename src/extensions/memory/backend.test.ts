import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { type KimchiConfig, loadConfig } from "../../config.js"
import {
	buildMemoryConfig,
	createMemoryBackend,
	defaultMemoryDir,
	EXTRACTION_MODEL,
	historyDbPath,
	MEMORY_EMBEDDING_DIMS,
	MEMORY_EMBEDDING_MODEL,
	memoryDbPath,
	projectDbPath,
	resolveExtractionModel,
	tagEmbeddingRequests,
} from "./backend.js"
import type { SharedEmbedder } from "./embedder.js"

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
		expect(config.llm.config.model).toBe(EXTRACTION_MODEL)
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

	it("a shared embedder rides in through the langchain provider", () => {
		const shared: SharedEmbedder = {
			embedQuery: async () => [1, 2, 3],
			embedDocuments: async (texts) => texts.map(() => [1, 2, 3]),
		}
		const config = buildMemoryConfig({ dbPath: "/tmp/mem.db", sharedEmbedder: shared }, testConfig())
		// mem0's LangchainEmbedder delegates to any embedQuery/embedDocuments
		// object passed as config.model — the seam that lets several stores
		// share one deduping gateway client.
		expect(config.embedder.provider).toBe("langchain")
		expect(config.embedder.config.model).toBe(shared)
		// The store schema still needs the resolved dimension.
		expect(config.vectorStore.config.dimension).toBe(MEMORY_EMBEDDING_DIMS)
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

describe("embedding endpoint configuration", () => {
	// The env knobs from the phase-1 A/B runs (MEMORY_EMBEDDING_*,
	// OPENROUTER_API_KEY) were removed — the model and dims come from the
	// kimchi config file (memoryEmbedding.model / .dims) or stay pinned.
	// This guards that leftover env from old setups neither redirects nor
	// breaks anything.
	it("ignores leftover MEMORY_EMBEDDING_* / OPENROUTER env from the A/B runs", () => {
		process.env.MEMORY_EMBEDDING_MODEL = "text-embedding-3-large"
		process.env.MEMORY_EMBEDDING_BASE_URL = "https://openrouter.ai/api/v1"
		process.env.MEMORY_EMBEDDING_API_KEY = "or-key"
		process.env.MEMORY_EMBEDDING_DIMS = "3072"
		process.env.OPENROUTER_API_KEY = "or-key"
		try {
			const config = buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())
			expect(config.embedder.config.baseURL).toBe("https://gateway.test/openai/v1")
			expect(config.embedder.config.apiKey).toBe("test-key")
			expect(config.embedder.config.model).toBe(MEMORY_EMBEDDING_MODEL)
			expect(config.embedder.config.embeddingDims).toBe(MEMORY_EMBEDDING_DIMS)
			expect(config.vectorStore.config.dimension).toBe(MEMORY_EMBEDDING_DIMS)
		} finally {
			delete process.env.MEMORY_EMBEDDING_MODEL
			delete process.env.MEMORY_EMBEDDING_BASE_URL
			delete process.env.MEMORY_EMBEDDING_API_KEY
			delete process.env.MEMORY_EMBEDDING_DIMS
			delete process.env.OPENROUTER_API_KEY
		}
	})

	it("applies memoryEmbedding.model and .dims from the config file", () => {
		const config = buildMemoryConfig(
			{ dbPath: "/tmp/mem.db" },
			testConfig({ memoryEmbedding: { model: "text-embedding-3-large", dims: 3072 } }),
		)
		expect(config.embedder.config.model).toBe("text-embedding-3-large")
		expect(config.embedder.config.embeddingDims).toBe(3072)
		expect(config.vectorStore.config.dimension).toBe(3072)
		// The gateway base URL and key are unchanged.
		expect(config.embedder.config.baseURL).toBe("https://gateway.test/openai/v1")
		expect(config.embedder.config.apiKey).toBe("test-key")
	})

	it("applies memoryExtraction.model to the mem0 llm config", () => {
		const config = buildMemoryConfig(
			{ dbPath: "/tmp/mem.db" },
			testConfig({ memoryExtraction: { model: "glm-5.3-flash" } }),
		)
		expect(config.llm.config.model).toBe("glm-5.3-flash")
		// The embedder is untouched by the extraction setting.
		expect(config.embedder.config.model).toBe(MEMORY_EMBEDDING_MODEL)
	})

	it("falls back to the pinned defaults without the config section", () => {
		const config = buildMemoryConfig({ dbPath: "/tmp/mem.db" }, testConfig())
		expect(config.embedder.config.model).toBe(MEMORY_EMBEDDING_MODEL)
		expect(config.embedder.config.embeddingDims).toBe(MEMORY_EMBEDDING_DIMS)
		expect(config.vectorStore.config.dimension).toBe(MEMORY_EMBEDDING_DIMS)
	})

	it("programmatic overrides win over the config file per-field", () => {
		const config = buildMemoryConfig(
			{ dbPath: "/tmp/mem.db", embedder: { model: "stub-model" } },
			testConfig({ memoryEmbedding: { model: "text-embedding-3-large", dims: 3072 } }),
		)
		expect(config.embedder.config.model).toBe("stub-model")
		// Dims have no programmatic seam — the config file still supplies them.
		expect(config.embedder.config.embeddingDims).toBe(3072)
	})
})

describe("config-file values reach the memory backend", () => {
	it("loadConfig output feeds buildMemoryConfig's embedder and store schema", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "kimchi-memcfg-"))
		const configPath = join(tempDir, "config.json")
		try {
			writeFileSync(
				configPath,
				JSON.stringify({
					apiKey: "file-key",
					memoryEmbedding: { model: "text-embedding-3-large", dims: 3072 },
					memoryExtraction: { model: "glm-5.3-flash" },
				}),
			)
			// The full chain a real session runs: the config file is loaded,
			// and the loaded config feeds the backend construction.
			const loaded = loadConfig({ configPath })
			const memConfig = buildMemoryConfig({ dbPath: "/tmp/mem.db" }, loaded)
			expect(memConfig.embedder.config.model).toBe("text-embedding-3-large")
			expect(memConfig.embedder.config.embeddingDims).toBe(3072)
			expect(memConfig.vectorStore.config.dimension).toBe(3072)
			expect(memConfig.llm.config.model).toBe("glm-5.3-flash")
		} finally {
			rmSync(tempDir, { recursive: true, force: true })
		}
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
					body: JSON.stringify({ input: ["text"], model: "bge-m3" }),
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
				// A non-gateway origin never receives the usage-tracking tag
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

	it("resolves deepseek flash when it is on the gateway list", async () => {
		const fetchImpl = vi
			.fn()
			.mockImplementation(() => Promise.resolve(okModels(["deepseek-v4-flash-0731", "glm-5.3-flash", "kimi-k3"])))
		expect(await resolveExtractionModel(gateway, { fetchImpl })).toBe(EXTRACTION_MODEL)
	})

	it("the config-file model is authoritative — no gateway query", async () => {
		const fetchImpl = vi.fn()
		expect(await resolveExtractionModel(gateway, { fetchImpl, configuredModel: "glm-5.3-flash" })).toBe("glm-5.3-flash")
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("uses deepseek flash when the model list is unreachable", async () => {
		const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response("boom", { status: 503 })))
		expect(await resolveExtractionModel(gateway, { fetchImpl })).toBe(EXTRACTION_MODEL)
	})

	it("throws a clear error when deepseek flash is unavailable", async () => {
		const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okModels(["glm-5.3-flash", "kimi-k3"])))
		await expect(resolveExtractionModel(gateway, { fetchImpl })).rejects.toThrow(/is not on the gateway's model list/)
	})
})

describe("resolveExtractionModel no longer calls the auto router", () => {
	const gateway = { baseURL: "https://gw.test/v1", apiKey: "k" }
	const okModels = (ids: string[]) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })

	it("resolves without any auto-router call", async () => {
		const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(okModels(["deepseek-v4-flash-0731"])))
		expect(await resolveExtractionModel(gateway, { fetchImpl })).toBe("deepseek-v4-flash-0731")
		for (const [input] of fetchImpl.mock.calls) {
			expect(String(input)).not.toContain("/v1/route")
		}
	})
})
