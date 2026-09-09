import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { KimchiConfig } from "../../config.js"
import {
	MEMORY_EMBEDDING_DIMS,
	MEMORY_EMBEDDING_MODEL,
	MEMORY_EXTRACTION_MODEL,
	buildMemoryConfig,
	createMemoryBackend,
	defaultMemoryDir,
	memoryDbPath,
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
		expect(config.llm.config.model).toBe(MEMORY_EXTRACTION_MODEL)
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
})

describe("createMemoryBackend", () => {
	it("rejects with a clear error when no API key resolves", async () => {
		await expect(createMemoryBackend({ dbPath: "/tmp/mem.db" }, testConfig({ apiKey: "" }))).rejects.toThrow(
			/API key/,
		)
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
})
