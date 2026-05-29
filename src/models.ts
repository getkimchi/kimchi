import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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
	status?: "active" | "sunset" | "deprecated"
	replacement?: string
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

export interface PiModelConfig {
	id: string
	name: string
	reasoning: boolean
	input: ("text" | "image")[]
	contextWindow: number
	maxTokens: number
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
	// Persisted so telemetry can resolve the actual upstream provider after cache round-trip.
	provider: string
	compat?: { supportsReasoningEffort?: boolean; cacheControlFormat?: "anthropic" }
	/** Model-level API type: upstream custom-provider parseModels falls through to this field. */
	api?: string
	/** Model-level base URL: upstream custom-provider parseModels falls through to this field. */
	baseUrl?: string
}

function metadataToModel(m: ModelMetadata): PiModelConfig {
	// TODO: our LiteLLM gateway does not support `thinking.type.enabled` for Anthropic >Opus 4.6 models
	// Therefore, we disable it for now. Revisit, once we upgrade our LiteLLM version.
	const compat =
		m.provider === "anthropic"
			? ({ supportsReasoningEffort: false, cacheControlFormat: "anthropic" } as const)
			: undefined
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

function extractModelsFromProviders(providers: Record<string, { models?: PiModelConfig[] }>): ModelMetadata[] {
	const result: ModelMetadata[] = []
	for (const [, provider] of Object.entries(providers)) {
		if (provider && typeof provider === "object" && Array.isArray(provider.models)) {
			result.push(...provider.models.map(modelToMetadata))
		}
	}
	return result
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

function readExistingProviders(modelsJsonPath: string): Record<string, unknown> {
	if (!existsSync(modelsJsonPath)) return {}
	try {
		const raw = readFileSync(modelsJsonPath, "utf-8")
		const config = JSON.parse(raw)
		const providers = config?.providers ?? {}
		const { "kimchi-dev": _kimchi, ...rest } = providers as Record<string, unknown>
		return rest
	} catch {
		return {}
	}
}

export async function validateApiKey(apiKey: string): Promise<void> {
	await fetchAvailableModels(apiKey)
}

/**
 * Overwrite or insert a provider's models in models.json.
 * Used after OAuth subscription login to persist upstream models into Kimchi's cache.
 */
export function syncProviderModels(
	modelsJsonPath: string,
	providerId: string,
	models: PiModelConfig[],
	providerConfig?: { api?: string; baseUrl?: string },
): void {
	let config: { providers?: Record<string, { api?: string; baseUrl?: string; models?: PiModelConfig[] }> } = {}
	if (existsSync(modelsJsonPath)) {
		config = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
	}
	if (!config.providers) config.providers = {}
	config.providers[providerId] = { ...providerConfig, models }
	writeFileSync(modelsJsonPath, JSON.stringify(config, null, "\t"), "utf-8")
}

/**
 * Fetch available models from the kimchi metadata API and write the
 * configuration to modelsJsonPath. If no API key is configured, returns
 * cached models (if available) or an empty list without making a network call.
 * If the fetch fails and the previous models.json is still on disk, returns
 * the cached models with a warning. Throws only when a key is present but
 * there is no cache to fall back on.
 *
 * User-added providers (anything other than "kimchi-dev") are preserved across
 * updates so custom model configurations are not lost on startup.
 */
export async function updateModelsConfig(modelsJsonPath: string, apiKey: string): Promise<ModelsConfigResult> {
	const dir = dirname(modelsJsonPath)
	mkdirSync(dir, { recursive: true })

	const otherProviders = readExistingProviders(modelsJsonPath)
	const otherModels = extractModelsFromProviders(otherProviders as Record<string, { models?: PiModelConfig[] }>)

	if (!apiKey) {
		return { models: sortModels([...(readCachedMetadata(modelsJsonPath) ?? []), ...otherModels]) }
	}

	let fetched: ModelMetadata[]
	try {
		fetched = await fetchAvailableModels(apiKey)
	} catch (err) {
		const cached = readCachedMetadata(modelsJsonPath) ?? []
		if (cached.length === 0 && otherModels.length === 0) throw err
		const message = err instanceof Error ? err.message : String(err)
		console.warn(`Failed to refresh models from API, using cached list: ${message}`)
		return { models: sortModels([...cached, ...otherModels]) }
	}

	const activeModels = fetched.filter((m) => m.status !== "sunset")
	if (activeModels.length === 0 && fetched.length > 0) {
		console.warn("All models from the API are sunset. No active models available.")
	}
	const models = sortModels(activeModels)
	const merged = { providers: { ...otherProviders, ...buildModelsConfig(models).providers } }
	writeFileSync(modelsJsonPath, JSON.stringify(merged, null, "\t"), "utf-8")
	return { models: sortModels([...activeModels, ...otherModels]) }
}
