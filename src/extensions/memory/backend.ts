/**
 * Memory backend construction: Mem0 OSS with the SQLite vector store
 * (hybrid BM25 + entity + semantic retrieval) and remote embeddings via
 * the kimchi gateway.
 *
 * The SQLite store is what makes mem0's TS SDK do hybrid retrieval — the
 * langchain adapter is semantic-only (see docs/memory-extension.md). The
 * store and mem0's history manager both require better-sqlite3, which does
 * not load under Bun; the shims/better-sqlite3 package (pnpm override)
 * provides it over bun:sqlite.
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
import { PROJECT_SEGMENT_RE, sanitizeScopeId } from "./scope.js"

export const MEMORY_EMBEDDING_MODEL = "bge-m3"
export const MEMORY_EMBEDDING_DIMS = 1024

/** One mem0 search hit, narrowed to the fields memory consumers read. */
export interface Mem0SearchHit {
	id: string
	memory: string
	score?: number
}

/**
 * mem0's search returns either a bare array or { results: [...] } depending
 * on the version and call path — unwrap and field-filter once, at every
 * call site, so a mem0 response-shape change is fixed in one place. Hits
 * without an id or memory are dropped (an id-less hit can never be deleted
 * or superseded anyway).
 */
export function normalizeMem0SearchResults(raw: unknown): Mem0SearchHit[] {
	const list = (Array.isArray(raw) ? raw : ((raw as { results?: unknown } | undefined)?.results ?? [])) as Array<{
		id?: string
		memory?: string
		score?: number
	}>
	return list.filter(
		(r): r is { id: string; memory: string; score?: number } =>
			typeof r.id === "string" && typeof r.memory === "string",
	)
}

/**
 * Extraction model — resolved against the gateway's live model list at
 * capture-worker start (models deprecate; per-user gateway access varies).
 * deepseek-v4-flash: benchmarks showed it is the only suitable model for
 * extraction, and the flash tier keeps capture latency low.
 */
export const EXTRACTION_MODEL = "deepseek-v4-flash-0731"

/** Options for {@link resolveExtractionModel}. */
export interface ExtractionModelOptions {
	/** Injectable for tests. */
	fetchImpl?: typeof fetch
	/** The config-file override (memoryExtraction.model). When set it is
	 * authoritative: returned without querying the gateway's model list —
	 * the user explicitly chose it. */
	configuredModel?: string
}

/**
 * Resolve the extraction model: the config-file override
 * (memoryExtraction.model in ~/.config/kimchi/config.json) wins;
 * otherwise deepseek-v4-flash when it's on the gateway's model list (one
 * cheap call). If the list itself is unreachable, use it anyway — a
 * likely-right model beats failing capture entirely. Throws when the list
 * is reachable and deepseek-v4-flash is not on it.
 *
 * Deliberately NOT routed through the auto router: benchmarking showed the
 * router picks models suited to conversation, not to strict-JSON extraction
 * at temperature 0.
 */
export async function resolveExtractionModel(
	gateway: { baseURL: string; apiKey: string },
	options: ExtractionModelOptions = {},
): Promise<string> {
	if (options.configuredModel) return options.configuredModel
	const fetchImpl = options.fetchImpl ?? fetch
	const available = await fetchAvailableModelIds(gateway, fetchImpl)
	if (available === undefined) {
		return EXTRACTION_MODEL
	}
	if (available.has(EXTRACTION_MODEL)) return EXTRACTION_MODEL
	throw new Error(
		`extraction model ${EXTRACTION_MODEL} is not on the gateway's model list — the gateway must serve it for memory capture, or set memoryExtraction.model in the kimchi config`,
	)
}

/** The gateway's model ids, or undefined when the list is unreachable. */
async function fetchAvailableModelIds(
	gateway: { baseURL: string; apiKey: string },
	fetchImpl: typeof fetch,
): Promise<Set<string> | undefined> {
	try {
		const response = await fetchImpl(
			new URL("models", gateway.baseURL.endsWith("/") ? gateway.baseURL : `${gateway.baseURL}/`),
			{ headers: { authorization: `Bearer ${gateway.apiKey}` } },
		)
		if (!response.ok) return undefined
		const body = (await response.json()) as { data?: Array<{ id?: string }> }
		return new Set((body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string"))
	} catch {
		// Unreachable list — the resolution degrades to the preferences.
		return undefined
	}
}

export const MEMORY_EMBEDDING_TAG = "memory:embedding"

/**
 * Tag the OpenAI embedder's gateway requests for usage tracking. mem0's
 * OpenAI embedder doesn't support extra body fields through its config
 * (the constructor only picks apiKey and baseURL), so the tag is injected
 * by wrapping globalThis.fetch — narrowly: only /embeddings requests to
 * the kimchi gateway get the tag added to their JSON body, in the same
 * payload field the /tags extension sets on session LLM requests, so
 * billing attributes memory traffic through one mechanism. Requests are
 * matched by origin so a request to any other host never receives our
 * usage-tracking tag. Idempotent (won't double-wrap). Applied at every
 * backend creation since the OpenAI SDK may capture the fetch reference at
 * client construction.
 */
export function tagEmbeddingRequests(gatewayBaseUrl: string): void {
	const current = globalThis.fetch as typeof fetch & { _memoryEmbeddingTagged?: boolean }
	if (current._memoryEmbeddingTagged) return
	const original = globalThis.fetch
	const gatewayOrigin = requestOrigin(gatewayBaseUrl)
	const tagged: typeof fetch & { _memoryEmbeddingTagged?: boolean } = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input?.url ?? "")
		if (url.includes("/embeddings") && init?.body && requestOrigin(url) === gatewayOrigin) {
			try {
				const body = JSON.parse(String(init.body)) as Record<string, unknown> & { tags?: string[] }
				const tags = Array.isArray(body.tags) ? [...body.tags] : []
				if (!tags.includes(MEMORY_EMBEDDING_TAG)) tags.push(MEMORY_EMBEDDING_TAG)
				return original(input, { ...init, body: JSON.stringify({ ...body, tags }) })
			} catch {
				// Not a JSON body — pass through untouched
			}
		}
		return original(input, init)
	}
	tagged._memoryEmbeddingTagged = true
	globalThis.fetch = tagged
}

function requestOrigin(url: string): string | undefined {
	try {
		return new URL(url).origin
	} catch {
		return undefined
	}
}

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
 * Per-project store path: `projects/<owner>/<name>/memory.db` under the
 * memory root. Project scope ids are `owner/name` segments — validated by
 * sanitizeScopeId (the strict personal regex does not allow slashes).
 */
export function projectDbPath(scopeId: string): string {
	const sanitized = sanitizeScopeId(scopeId)
	if (!sanitized) {
		throw new Error(`invalid project scope id: ${JSON.stringify(scopeId)} (allowed segments: ${PROJECT_SEGMENT_RE})`)
	}
	return join(defaultMemoryDir(), "projects", ...sanitized.split("/"), "memory.db")
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

/** Embedding endpoint plus its vector dimension (the two must move together). */
export interface EmbeddingEndpointConfig extends MemoryEndpointConfig {
	dims: number
}

/**
 * Embedding endpoint: the kimchi gateway with the open-weight model
 * (bge-m3 at 1024 dims — the phase-1 embedding study's choice) as the
 * default. The model and dimensions are user-configurable via the config
 * file (memoryEmbedding.model / memoryEmbedding.dims in
 * ~/.config/kimchi/config.json); env-var configuration was deliberately
 * removed after the phase-1 A/B runs. The pair must move together — the
 * vector store schema is built from the dims. Programmatic overrides
 * (tests, check scripts) win per-field.
 */
export function resolveEmbeddingEndpoint(
	override: Partial<MemoryEndpointConfig> | undefined,
	gateway: { baseURL: string; apiKey: string },
	config?: { memoryEmbedding?: { model?: string; dims?: number } },
): EmbeddingEndpointConfig {
	const configModel =
		typeof config?.memoryEmbedding?.model === "string" && config.memoryEmbedding.model.length > 0
			? config.memoryEmbedding.model
			: undefined
	return {
		baseURL: override?.baseURL ?? gateway.baseURL,
		apiKey: override?.apiKey ?? gateway.apiKey,
		model: override?.model ?? configModel ?? MEMORY_EMBEDDING_MODEL,
		dims: config?.memoryEmbedding?.dims ?? MEMORY_EMBEDDING_DIMS,
	}
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
	const embedder = resolveEmbeddingEndpoint(options.embedder, gateway, config)
	const llm = resolveEndpoint(options.llm, gateway, config.memoryExtraction?.model ?? EXTRACTION_MODEL)
	return {
		embedder: {
			provider: "openai",
			config: {
				model: embedder.model,
				baseURL: embedder.baseURL,
				apiKey: embedder.apiKey,
				embeddingDims: embedder.dims,
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
				dimension: embedder.dims,
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
	const embedder = resolveEmbeddingEndpoint(options.embedder, gateway, config)
	const llm = resolveEndpoint(options.llm, gateway, config.memoryExtraction?.model ?? EXTRACTION_MODEL)
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
	tagEmbeddingRequests(config.llmEndpoint)
	const { Memory } = await import("mem0ai/oss")
	return new Memory(buildMemoryConfig(options, config))
}
