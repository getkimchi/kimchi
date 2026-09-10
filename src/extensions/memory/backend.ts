/**
 * Memory backend construction: Mem0 OSS with the SQLite vector store
 * (hybrid BM25 + entity + semantic retrieval) and remote embeddings via
 * the kimchi gateway.
 *
 * The SQLite store is what makes mem0's TS SDK do hybrid retrieval — the
 * langchain adapter is semantic-only (see
 * benchmark/memory-spike/results/sqlite-investigation.md). The store and
 * mem0's history manager both require better-sqlite3, which does not load
 * under Bun; the shims/better-sqlite3 package (pnpm override) provides it
 * over bun:sqlite.
 *
 * Constructing a backend requires the Bun runtime (bun:sqlite through the
 * shim); vitest on Node can still import this module and test the config
 * builders — same pattern as src/integrations/cursor.ts. The Bun-runtime
 * acceptance check is `pnpm run memory:check` (backend.check.ts).
 */
import { homedir } from "node:os"
import { join } from "node:path"
import type { Memory as Mem0Memory, MemoryConfig } from "mem0ai/oss"
import { type KimchiConfig, loadConfig } from "../../config.js"

export const MEMORY_EMBEDDING_MODEL = "text-embedding-3-small"
export const MEMORY_EMBEDDING_DIMS = 1536
export const MEMORY_EXTRACTION_MODEL = "kimi-k3"

export function defaultMemoryDir(): string {
	return join(homedir(), ".config", "kimchi", "memory")
}

/** Scope ids interpolate into filesystem paths — allowlist strictly. */
const SCOPE_ID_RE = /^[a-z0-9-]+$/

export function memoryDbPath(scopeId: string): string {
	if (!SCOPE_ID_RE.test(scopeId)) {
		throw new Error(`invalid memory scope id: ${JSON.stringify(scopeId)} (allowed: ${SCOPE_ID_RE})`)
	}
	return join(defaultMemoryDir(), scopeId, "memory.db")
}

/**
 * History DB path: the same .kimchi memory directory as the vector store.
 * mem0's default is a cwd-relative memory.db — unconfigured, concurrent
 * sessions collide on it and local runs litter the cwd (both seen in the
 * benchmark investigation).
 */
export function historyDbPath(dbPath: string): string {
	return dbPath.endsWith(".db") ? `${dbPath.slice(0, -3)}-history.db` : `${dbPath}-history.db`
}

export interface MemoryEndpointConfig {
	baseURL: string
	apiKey: string
	model: string
}

export interface MemoryBackendOptions {
	/** SQLite database path for the vector store (see memoryDbPath). */
	dbPath: string
	/** Embedding endpoint override — tests point this at a local stub. */
	embedder?: Partial<MemoryEndpointConfig>
	/** Extraction LLM override — tests point this at a local stub. */
	llm?: Partial<MemoryEndpointConfig>
}

function resolveEndpoint(
	override: Partial<MemoryEndpointConfig> | undefined,
	gateway: { baseURL: string; apiKey: string },
	defaultModel: string,
): MemoryEndpointConfig {
	return {
		baseURL: override?.baseURL ?? gateway.baseURL,
		apiKey: override?.apiKey ?? gateway.apiKey,
		model: override?.model ?? defaultModel,
	}
}

/**
 * Build the mem0 MemoryConfig for a backend. Pure — safe to call under
 * vitest on Node.
 */
export function buildMemoryConfig(options: MemoryBackendOptions, config: KimchiConfig = loadConfig()): MemoryConfig {
	const gateway = { baseURL: config.llmEndpoint, apiKey: config.apiKey }
	const embedder = resolveEndpoint(options.embedder, gateway, MEMORY_EMBEDDING_MODEL)
	const llm = resolveEndpoint(options.llm, gateway, MEMORY_EXTRACTION_MODEL)
	return {
		embedder: {
			provider: "openai",
			config: {
				model: embedder.model,
				baseURL: embedder.baseURL,
				apiKey: embedder.apiKey,
				embeddingDims: MEMORY_EMBEDDING_DIMS,
			},
		},
		llm: {
			provider: "openai",
			config: {
				model: llm.model,
				apiKey: llm.apiKey,
				baseURL: llm.baseURL,
			},
		},
		vectorStore: {
			provider: "memory",
			config: {
				dbPath: options.dbPath,
				dimension: MEMORY_EMBEDDING_DIMS,
			},
		},
		historyStore: {
			provider: "sqlite",
			config: {
				historyDbPath: historyDbPath(options.dbPath),
			},
		},
	}
}

/**
 * Disable mem0's OSS PostHog telemetry. Must run before the FIRST import of
 * mem0ai/oss — the flag is read once at module scope. Must be called by
 * every entry point that imports mem0 directly (backend.check.ts, the
 * capture worker).
 */
export function disableMem0Telemetry(): void {
	if (process.env.MEM0_TELEMETRY === undefined) {
		process.env.MEM0_TELEMETRY = "false"
	}
}

/**
 * Construct the memory backend. Requires the Bun runtime (the SQLite store
 * loads better-sqlite3, which resolves to our bun:sqlite shim). The
 * mem0ai import is dynamic so the heavy dependency surface loads only
 * when memory is actually used.
 */
export async function createMemoryBackend(
	options: MemoryBackendOptions,
	config: KimchiConfig = loadConfig(),
): Promise<Mem0Memory> {
	const gateway = { baseURL: config.llmEndpoint, apiKey: config.apiKey }
	const embedder = resolveEndpoint(options.embedder, gateway, MEMORY_EMBEDDING_MODEL)
	const llm = resolveEndpoint(options.llm, gateway, MEMORY_EXTRACTION_MODEL)
	for (const [name, ep] of [
		["embedder", embedder],
		["llm", llm],
	] as const) {
		if (!ep.apiKey) {
			throw new Error(`memory backend ${name} requires an API key — set KIMCHI_API_KEY or run \`kimchi setup\``)
		}
	}
	// mem0's OSS telemetry phones home to PostHog unless MEM0_TELEMETRY is
	// "false" when the module loads. Memory content and usage must not
	// egress to third parties. An explicitly set value wins, so an operator
	// who opts in deliberately keeps it.
	disableMem0Telemetry()
	const { Memory } = await import("mem0ai/oss")
	return new Memory(buildMemoryConfig(options, config))
}
