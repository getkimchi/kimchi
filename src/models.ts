import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { getVersion } from "./utils.js"

const KIMCHI_API = "https://llm.kimchi.dev"
const MODELS_METADATA_API = `${KIMCHI_API}/v1/models/metadata?include_in_cli=true`
const CHAT_COMPLETIONS_API = `${KIMCHI_API}/openai/v1`
const FETCH_TIMEOUT_MS = 5000

export interface ModelMetadata {
	slug: string
	display_name: string
	provider: string
	reasoning: boolean
	input_modalities: ("text" | "image")[]
	is_serverless: boolean
	limits: {
		context_window: number
		max_output_tokens: number
	}
}

interface ModelsMetadataResponse {
	models: ModelMetadata[]
}

function sortModels(models: ModelMetadata[]): ModelMetadata[] {
	const serverless = models.filter((m) => m.is_serverless)
	const rest = models.filter((m) => !m.is_serverless)
	return [...serverless, ...rest]
}

async function fetchAvailableModels(apiKey: string): Promise<ModelMetadata[]> {
	const response = await fetch(MODELS_METADATA_API, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})
	if (!response.ok) {
		throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
	}
	const body = (await response.json()) as ModelsMetadataResponse
	if (!Array.isArray(body?.models)) {
		throw new Error("Unexpected response shape from models API")
	}
	if (body.models.length === 0) {
		throw new Error("API returned empty model list")
	}
	return body.models
}

interface PiModelConfig {
	id: string
	name: string
	reasoning: boolean
	input: ("text" | "image")[]
	contextWindow: number
	maxTokens: number
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
	// Persisted so telemetry can resolve the actual upstream provider after cache round-trip.
	provider: string
	compat?: { supportsReasoningEffort?: boolean }
}

function metadataToModel(m: ModelMetadata): PiModelConfig {
	// TODO: our LiteLLM gateway does not support `thinking.type.enabled` for Anthropic >Opus 4.6 models
	// Therefore, we disable it for now. Revisit, once we upgrade our LiteLLM version.
	const compat = m.provider === "anthropic" ? { supportsReasoningEffort: false } : undefined
	return {
		id: m.slug,
		name: m.display_name.trim().length > 0 ? m.display_name : m.slug,
		reasoning: m.reasoning,
		input: m.input_modalities,
		contextWindow: m.limits.context_window,
		maxTokens: m.limits.max_output_tokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// Store upstream provider for telemetry round-trip via models.json
		provider: m.provider,
		...(compat && { compat }),
	}
}

function buildModelsConfig(models: ModelMetadata[]) {
	return {
		providers: {
			"kimchi-dev": {
				baseUrl: CHAT_COMPLETIONS_API,
				apiKey: "KIMCHI_API_KEY",
				api: "openai-completions",
				authHeader: true,
				cacheControlFormat: "anthropic",
				headers: { "User-Agent": `kimchi/${getVersion()}` },
				models: models.map(metadataToModel),
			},
		},
	}
}

export interface ModelsConfigResult {
	models: ModelMetadata[]
}

function modelToMetadata(m: PiModelConfig): ModelMetadata {
	return {
		slug: m.id,
		display_name: m.name,
		// If `provider` was persisted by metadataToModel, use it. Fall back to the
		// legacy compat heuristic for files written by older CLI versions.
		provider: m.provider || (m.compat ? "anthropic" : ""),
		reasoning: m.reasoning,
		input_modalities: m.input,
		is_serverless: true,
		limits: { context_window: m.contextWindow, max_output_tokens: m.maxTokens },
	}
}

function readCachedMetadata(modelsJsonPath: string): ModelMetadata[] | undefined {
	try {
		const raw = readFileSync(modelsJsonPath, "utf-8")
		const parsed = JSON.parse(raw)
		const models = parsed?.providers?.["kimchi-dev"]?.models
		if (!Array.isArray(models) || models.length === 0) return undefined
		return (models as PiModelConfig[]).map(modelToMetadata)
	} catch {
		return undefined
	}
}

export async function validateApiKey(apiKey: string): Promise<void> {
	await fetchAvailableModels(apiKey)
}

/**
 * Fetch available models from the kimchi metadata API and write the
 * configuration to modelsJsonPath. If no API key is configured, returns
 * cached models (if available) or an empty list without making a network call.
 * If the fetch fails and the previous models.json is still on disk, returns
 * the cached models with a warning. Throws only when a key is present but
 * there is no cache to fall back on.
 */
export async function updateModelsConfig(modelsJsonPath: string, apiKey: string): Promise<ModelsConfigResult> {
	const dir = dirname(modelsJsonPath)
	mkdirSync(dir, { recursive: true })

	if (!apiKey) {
		return { models: readCachedMetadata(modelsJsonPath) ?? [] }
	}

	let fetched: ModelMetadata[]
	try {
		fetched = await fetchAvailableModels(apiKey)
	} catch (err) {
		const cached = readCachedMetadata(modelsJsonPath)
		if (!cached) throw err
		const message = err instanceof Error ? err.message : String(err)
		console.warn(`Failed to refresh models from API, using cached list: ${message}`)
		return { models: cached }
	}

	const models = sortModels(fetched)
	writeFileSync(modelsJsonPath, JSON.stringify(buildModelsConfig(models), null, "\t"), "utf-8")
	return { models }
}
