/**
 * Native Ollama provider support — probe a locally-running Ollama server,
 * persist discovered models into models.json, expose them through the existing
 * PiModelConfig shape, and wire them into role pools.
 *
 * All operations are deliberately silent on failure: Ollama is optional and
 * its absence must never block startup or any other startup path. Every public
 * function returns `[]` / no-ops instead of throwing.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { debuglog } from "node:util"

import type { ModelRoles, RoleModelAssignment } from "./extensions/orchestration/model-roles.js"
import { normalizeRoleModels } from "./extensions/orchestration/model-roles.js"
import type { ModelMetadata, PiModelConfig } from "./models.js"

const DEFAULT_OLLAMA_HOST = "http://localhost:11434"
const DEFAULT_TIMEOUT_MS = 2000
const DEFAULT_CONTEXT_WINDOW = 32768
const DEFAULT_MAX_TOKENS = 8192
/** Concurrency cap for parallel /api/show enrichment during a probe.
 *  Sequential was N × RTT; with limit=4 a 10-model probe is ~2.5 × RTT instead. */
const PROBE_CONCURRENCY = 4

/** Silent debug logger — only emits when NODE_DEBUG matches the namespace.
 *  Used inside catch blocks so failures are observable when debugging without
 *  producing default-on noise (spec criterion #6). */
const debugOllama = debuglog("kimi:ollama")

/** Run an array of async thunks with at most `limit` in flight at once.
 *  Preserves input order in the returned array (i.e. output[i] corresponds to
 *  the thunk at items[i]). No new runtime dependency. */
async function mapWithConcurrency<T>(items: Array<() => Promise<T>>, limit: number): Promise<T[]> {
	if (items.length === 0) return []
	const results: T[] = new Array(items.length)
	let nextIndex = 0
	const worker = async (): Promise<void> => {
		while (true) {
			const i = nextIndex++
			if (i >= items.length) return
			results[i] = await items[i]()
		}
	}
	const workerCount = Math.max(1, Math.min(limit, items.length))
	await Promise.all(Array.from({ length: workerCount }, () => worker()))
	return results
}

/** Heavy tier threshold (parameter count in billions). */
const TIER_HEAVY_MIN_B = 30
/** Standard tier threshold (parameter count in billions). */
const TIER_STANDARD_MIN_B = 8

const OLLAMA_PROVIDER_ID = "ollama"

/** Raw entry from Ollama's GET /api/tags. Only the fields we actually consume
 *  are typed; everything else is opaque. */
interface OllamaTagsEntry {
	name?: string
	model?: string
	modified_at?: string
	size?: number
	digest?: string
	details?: {
		parameter_size?: string
		family?: string
		families?: string[]
		quantization_level?: string
		format?: string
		parent_model?: string
	}
	capabilities?: string[]
}

/** Raw envelope returned by GET /api/tags. */
interface OllamaTagsResponse {
	models?: OllamaTagsEntry[]
}

/** Raw envelope returned by POST /api/show. We only consume `model_info` (which
 *  carries `*.context_length` keys) and `capabilities`. */
interface OllamaShowResponse {
	model_info?: Record<string, unknown>
	capabilities?: string[]
	modified_at?: string
}

export interface OllamaProbeOptions {
	/** Per-request timeout in milliseconds. Defaults to 2000. */
	timeoutMs?: number
	/** Injected fetch for deterministic tests. Defaults to the global fetch. */
	fetch?: typeof fetch
}

/** Normalized representation of a model discovered via Ollama's native API.
 *  This is the internal type that feeds `ollamaToModelConfig`. */
export interface OllamaModel {
	/** Ollama model reference (e.g. "llama3:8b"). Acts as both display name
	 *  and registry id; consumers should reference `name` for both purposes. */
	name: string
	/** Parameter size in billions (e.g. 8.0, 30, 70). `null` when unknown. */
	parameterSize: number | null
	contextWindow: number
	inputModalities: ("text" | "image")[]
	reasoning: boolean
	family: string
	quantization: string
}

/** Strip trailing slashes from a host string. Empty/whitespace input is
 *  treated as absent and replaced with the default Ollama endpoint. */
function normalizeOllamaHost(host: string | undefined): string {
	const trimmed = host?.trim()
	const candidate = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_OLLAMA_HOST
	return candidate.replace(/\/+$/, "")
}

/** Resolve the Ollama endpoint from the environment.
 *  Priority: $OLLAMA_HOST > $KIMCHI_OLLAMA_HOST > http://localhost:11434.
 *  Exported so callers (e.g. cli.ts) can probe + persist against the same
 *  host without re-implementing env-var precedence. */
export function resolveOllamaHost(): string {
	const fromEnv = process.env.OLLAMA_HOST?.trim() || process.env.KIMCHI_OLLAMA_HOST?.trim()
	return normalizeOllamaHost(fromEnv)
}

/** Parse Ollama's human-readable parameter_size strings (e.g. "8.0B", "30B",
 *  "1.5B", "70B", "?"). Returns the value in billions, or null when unknown. */
function parseParameterSize(raw: string | undefined): number | null {
	if (!raw) return null
	const trimmed = raw.trim()
	if (trimmed.length === 0 || trimmed === "?") return null

	const match = /^([0-9]*\.?[0-9]+)\s*([BbMm])$/.exec(trimmed)
	if (!match) return null

	const value = Number.parseFloat(match[1])
	if (!Number.isFinite(value) || value <= 0) return null

	// Convert millions to billions for downstream tier heuristic consistency.
	return match[2].toUpperCase() === "M" ? value / 1000 : value
}

/** Find a context length value inside the /api/show `model_info` blob. Ollama
 *  exposes it under arch-specific keys like `llama.context_length` or
 *  `qwen2.context_length`. Returns the first positive integer found. */
function extractContextWindow(modelInfo: Record<string, unknown> | undefined): number | undefined {
	if (!modelInfo) return undefined
	for (const [key, value] of Object.entries(modelInfo)) {
		if (!key.endsWith(".context_length")) continue
		const n = typeof value === "number" ? value : Number(value)
		if (Number.isFinite(n) && n > 0) return Math.trunc(n)
	}
	return undefined
}

/** Convert an Ollama capabilities array into our input modalities + reasoning
 *  flag. `text` is always present; `image` is added when "vision" appears.
 *  Reasoning is set when "thinking" appears. */
function deriveFromCapabilities(capabilities: readonly string[] | undefined): {
	inputModalities: ("text" | "image")[]
	reasoning: boolean
} {
	const caps = new Set(capabilities ?? [])
	const inputModalities: ("text" | "image")[] = ["text"]
	if (caps.has("vision")) inputModalities.push("image")
	return {
		inputModalities,
		reasoning: caps.has("thinking"),
	}
}

/** Resolve a list of candidate model reference strings from a /api/tags entry,
 *  preferring `model` then `name` then the entry's own `name`. */
function modelRefFromTagsEntry(entry: OllamaTagsEntry): string | undefined {
	const candidate = entry.model ?? entry.name
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined
}

/** Pull context length + refined capabilities from /api/show. Returns the
 *  defaults from the tags entry when /api/show fails or yields no context info. */
async function enrichFromShow(
	host: string,
	name: string,
	fallbackContext: number,
	tagsCapabilities: string[] | undefined,
	options: OllamaProbeOptions,
): Promise<{ contextWindow: number; reasoning: boolean; inputModalities: ("text" | "image")[] }> {
	const fetchImpl = options.fetch ?? fetch
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
	const url = `${host}/api/show`

	let response: Response
	try {
		response = await fetchImpl(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name }),
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch {
		return { contextWindow: fallbackContext, ...deriveFromCapabilities(tagsCapabilities) }
	}

	if (!response.ok) {
		const derived = deriveFromCapabilities(tagsCapabilities)
		return { contextWindow: fallbackContext, reasoning: derived.reasoning, inputModalities: derived.inputModalities }
	}

	let body: OllamaShowResponse
	try {
		body = (await response.json()) as OllamaShowResponse
	} catch {
		const derived = deriveFromCapabilities(tagsCapabilities)
		return { contextWindow: fallbackContext, reasoning: derived.reasoning, inputModalities: derived.inputModalities }
	}

	const contextWindow = extractContextWindow(body.model_info) ?? fallbackContext
	const derived = deriveFromCapabilities(body.capabilities ?? tagsCapabilities)
	return {
		contextWindow,
		reasoning: derived.reasoning,
		inputModalities: derived.inputModalities,
	}
}

/**
 * Probe a locally-running Ollama server and return its discovered models.
 *
 * Hits `${host}/api/tags` for the canonical list, then enriches each entry via
 * `${host}/api/show`. Per-model /api/show failures are non-fatal — the entry
 * is kept with whatever data /api/tags provided plus sensible defaults.
 *
 * Network failures, timeouts, non-2xx responses, and malformed bodies all
 * resolve to `[]` instead of throwing, so callers can probe unconditionally
 * without try/catch.
 */
export async function probeOllamaModels(host: string, options: OllamaProbeOptions = {}): Promise<OllamaModel[]> {
	const normalizedHost = normalizeOllamaHost(host)
	const fetchImpl = options.fetch ?? fetch
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

	let response: Response
	try {
		response = await fetchImpl(`${normalizedHost}/api/tags`, {
			signal: AbortSignal.timeout(timeoutMs),
		})
	} catch {
		return []
	}

	if (!response.ok) return []

	let payload: OllamaTagsResponse
	try {
		payload = (await response.json()) as OllamaTagsResponse
	} catch {
		return []
	}

	const rawEntries = Array.isArray(payload.models) ? payload.models : []

	const enriched = await mapWithConcurrency(
		rawEntries.map((entry) => async () => {
			const ref = modelRefFromTagsEntry(entry)
			if (!ref) return null
			const details = entry.details ?? {}
			const parameterSize = parseParameterSize(details.parameter_size)
			const fallbackContext = DEFAULT_CONTEXT_WINDOW
			const show = await enrichFromShow(normalizedHost, ref, fallbackContext, entry.capabilities, options)
			return {
				name: ref,
				parameterSize,
				contextWindow: show.contextWindow,
				inputModalities: show.inputModalities,
				reasoning: show.reasoning,
				family: typeof details.family === "string" ? details.family : "",
				quantization: typeof details.quantization_level === "string" ? details.quantization_level : "",
			}
		}),
		PROBE_CONCURRENCY,
	)

	return enriched.filter((m): m is OllamaModel => m !== null)
}

/** Classify an OllamaModel into a tier based on its parameter size. Unknown
 *  parameter sizes fall back to "standard" as a sensible default — users can
 *  override the model in models.json. */
export function ollamaModelTier(model: OllamaModel): "light" | "standard" | "heavy" {
	if (model.parameterSize === null) return "standard"
	if (model.parameterSize >= TIER_HEAVY_MIN_B) return "heavy"
	if (model.parameterSize >= TIER_STANDARD_MIN_B) return "standard"
	return "light"
}

/** Convert a discovered OllamaModel into the PiModelConfig shape consumed by
 *  the rest of the harness. Cost is zero across the board (local inference).
 *  Max output tokens are capped at 8192 to avoid runaway defaults. */
export function ollamaToModelConfig(model: OllamaModel): PiModelConfig {
	return {
		id: model.name,
		name: model.name,
		reasoning: model.reasoning,
		input: model.inputModalities,
		contextWindow: model.contextWindow,
		maxTokens: Math.min(model.contextWindow, DEFAULT_MAX_TOKENS),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		provider: OLLAMA_PROVIDER_ID,
	}
}

export interface InjectOllamaProviderOptions extends OllamaProbeOptions {
	/** When true, force the rewrite even when no existing models.json is on
	 *  disk. Defaults to false — without a baseline we have nothing to merge
	 *  with and we'd rather not create a half-empty file. */
	createIfMissing?: boolean
}

/** Read the providers map from an existing models.json, preserving every key
 *  (including the kimchi-dev and kimchi-experimental slots managed by
 *  src/models.ts). Mirrors the same non-destructive read pattern used by
 *  `injectExperimentalProvider` in src/models.ts. */
function readAllProviders(modelsJsonPath: string): Record<string, unknown> {
	if (!existsSync(modelsJsonPath)) return {}
	try {
		const raw = readFileSync(modelsJsonPath, "utf-8")
		const parsed = JSON.parse(raw)
		const providers = parsed?.providers
		if (!providers || typeof providers !== "object") return {}
		return providers as Record<string, unknown>
	} catch {
		return {}
	}
}

/**
 * Probe Ollama and merge its models into models.json under the "ollama"
 * provider. The provider block uses `api: "openai-completions"` against
 * `${host}/v1` so the existing Pi model registry can talk to Ollama via its
 * OpenAI-compatible surface.
 *
 * Behaviour:
 *  - Empty probe result → silent no-op.
 *  - Absent models.json → silent no-op unless `options.createIfMissing`.
 *  - Any thrown error → swallowed (returns undefined).
 *
 * Non-Kimchi providers already in models.json are preserved.
 */
export async function injectOllamaProvider(
	modelsJsonPath: string,
	host: string,
	options: InjectOllamaProviderOptions = {},
): Promise<void> {
	try {
		const models = await probeOllamaModels(host, options)

		// Spec criterion #6: when Ollama is unreachable, the `ollama` provider
		// must be omitted from models.json — including any pre-existing block
		// left behind by a previous run when Ollama was online.
		if (models.length === 0) {
			if (!existsSync(modelsJsonPath)) return
			const existingProviders = readAllProviders(modelsJsonPath)
			if (!(OLLAMA_PROVIDER_ID in existingProviders)) return
			const { [OLLAMA_PROVIDER_ID]: _staleOllama, ...remaining } = existingProviders
			writeFileSync(modelsJsonPath, JSON.stringify({ providers: remaining }, null, "\t"), "utf-8")
			return
		}

		if (!existsSync(modelsJsonPath) && !options.createIfMissing) return

		const existingProviders = readAllProviders(modelsJsonPath)
		const normalizedHost = normalizeOllamaHost(host)
		const ollamaProvider = {
			api: "openai-completions",
			baseUrl: `${normalizedHost}/v1`,
			// pi-coding-agent's openai-completions provider requires a non-empty
			// `apiKey` at runtime (`throw new Error("No API key for provider: ...")`)
			// and its model registry refuses to register a custom provider without
			// one ("apiKey is required when defining custom models"). Ollama itself
			// ignores the value, so any non-empty sentinel satisfies the contract.
			apiKey: "ollama-no-key-needed",
			models: models.map(ollamaToModelConfig),
		}

		const merged = {
			providers: {
				...existingProviders,
				[OLLAMA_PROVIDER_ID]: ollamaProvider,
			},
		}
		writeFileSync(modelsJsonPath, JSON.stringify(merged, null, "\t"), "utf-8")
	} catch (error) {
		// Spec criterion #6: silent by default — startup must never be blocked
		// by Ollama. `debuglog` is OFF unless the user opts in via
		// NODE_DEBUG=kimi:ollama (or includes 'kimi:*'), so this satisfies the
		// "no warning noise" criterion while still giving disk-full /
		// permission errors an observable trail when debugging.
		debugOllama("injectOllamaProvider failed: %s", error instanceof Error ? error.message : String(error))
	}
}

/** Read the Ollama provider block back out of models.json and return the
 *  models in the ModelMetadata shape used by the rest of the startup path.
 *  Returns an empty array when the file is missing, malformed, or contains
 *  no Ollama provider. The `is_serverless` flag mirrors what
 *  `readExperimentalModels` writes so downstream sort + dedupe behave the same. */
export function readOllamaModelsFromConfig(modelsJsonPath: string): PiModelConfig[] {
	try {
		const raw = readFileSync(modelsJsonPath, "utf-8")
		const parsed = JSON.parse(raw)
		const models = parsed?.providers?.[OLLAMA_PROVIDER_ID]?.models
		if (!Array.isArray(models)) return []
		// Defensive runtime guard: a hand-edited or corrupted models.json could
		// contain null / primitives / objects missing the required `id`. Filter
		// to entries that look like a real PiModelConfig before they reach
		// `augmentModelRolesWithOllama` (which would otherwise produce
		// `ollama/undefined` refs in the role pools).
		return models.filter(
			(m): m is PiModelConfig => !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string",
		) as PiModelConfig[]
	} catch {
		return []
	}
}

/** Same as `readOllamaModelsFromConfig` but produces ModelMetadata-shaped
 *  rows for the cli.ts models array. Mirrors the role of
 *  `readExperimentalModels` from src/models.ts. */
export function readOllamaModelMetadata(modelsJsonPath: string): ModelMetadata[] {
	const configs = readOllamaModelsFromConfig(modelsJsonPath)
	return configs.map((c) => ({
		slug: c.id,
		display_name: c.name,
		provider: c.provider ?? OLLAMA_PROVIDER_ID,
		reasoning: c.reasoning,
		input_modalities: c.input,
		is_serverless: true,
		limits: { context_window: c.contextWindow, max_output_tokens: c.maxTokens },
	}))
}

/** Append an Ollama model ref to a role pool, returning the new assignment.
 *  Accepts either a string or an array (the `RoleModelAssignment` union) and
 *  dedupes against existing entries. */
function appendToAssignment(value: RoleModelAssignment, ref: string): RoleModelAssignment {
	const existing = normalizeRoleModels(value)
	if (existing.includes(ref)) return value
	const next = [...existing, ref]
	return next.length === 1 ? next[0] : next
}

/** Build the `ollama/<ref>` model reference consumed by the registry. */
function refForOllamaModel(model: PiModelConfig | OllamaModel): string {
	return `ollama/${model.name}`
}

/**
 * Add discovered Ollama models to the explorer / reviewer / builder role pools.
 * Returns a fresh ModelRoles object — the input is not mutated. Orchestrator,
 * planner, and judge are intentionally left untouched so Ollama never displaces
 * the main agent loop.
 */
export function augmentModelRolesWithOllama(
	roles: ModelRoles,
	models: readonly (PiModelConfig | OllamaModel)[],
): ModelRoles {
	if (models.length === 0) return roles

	const next: ModelRoles = {
		orchestrator: roles.orchestrator,
		planner: roles.planner,
		judge: roles.judge,
		builder: roles.builder,
		reviewer: roles.reviewer,
		explorer: roles.explorer,
	}

	for (const model of models) {
		const ref = refForOllamaModel(model)
		next.builder = appendToAssignment(next.builder, ref)
		next.reviewer = appendToAssignment(next.reviewer, ref)
		next.explorer = appendToAssignment(next.explorer, ref)
	}

	return next
}
