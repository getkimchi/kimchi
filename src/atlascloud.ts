import { existsSync, readFileSync, writeFileSync } from "node:fs"

import type { ModelMetadata, PiModelConfig } from "./models.js"

const ATLASCLOUD_PROVIDER_ID = "atlascloud"
const ATLASCLOUD_BASE_URL = "https://api.atlascloud.ai/v1"
const ATLASCLOUD_API_KEY = "$ATLASCLOUD_API_KEY"
const MODEL_INPUT_MODALITIES = new Set(["text", "image"])

const ATLASCLOUD_MODELS: readonly PiModelConfig[] = [
	{
		id: "qwen/qwen3.5-flash",
		name: "Qwen3.5 Flash",
		reasoning: false,
		input: ["text"],
		contextWindow: 1_000_000,
		maxTokens: 67_072,
		cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 },
		provider: ATLASCLOUD_PROVIDER_ID,
	},
	{
		id: "deepseek-ai/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_048_576,
		maxTokens: 393_216,
		cost: { input: 1.68, output: 3.38, cacheRead: 0.13, cacheWrite: 0 },
		provider: ATLASCLOUD_PROVIDER_ID,
	},
]

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readModelsConfig(modelsJsonPath: string): Record<string, unknown> {
	if (!existsSync(modelsJsonPath)) return {}

	const parsed: unknown = JSON.parse(readFileSync(modelsJsonPath, "utf-8"))
	if (!isRecord(parsed)) {
		throw new Error("models.json must contain a JSON object")
	}
	if (parsed.providers !== undefined && !isRecord(parsed.providers)) {
		throw new Error("models.json providers must contain a JSON object")
	}
	return parsed
}

function isPiModelConfig(value: unknown): value is PiModelConfig {
	if (!isRecord(value)) return false
	const cost = value.cost
	return (
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		typeof value.reasoning === "boolean" &&
		Array.isArray(value.input) &&
		value.input.every((modality) => typeof modality === "string" && MODEL_INPUT_MODALITIES.has(modality)) &&
		typeof value.contextWindow === "number" &&
		Number.isFinite(value.contextWindow) &&
		typeof value.maxTokens === "number" &&
		Number.isFinite(value.maxTokens) &&
		typeof value.provider === "string" &&
		isRecord(cost) &&
		typeof cost.input === "number" &&
		typeof cost.output === "number" &&
		typeof cost.cacheRead === "number" &&
		typeof cost.cacheWrite === "number"
	)
}

function atlasCloudProviderConfig(): {
	api: string
	baseUrl: string
	apiKey: string
	authHeader: boolean
	models: readonly PiModelConfig[]
} {
	return {
		api: "openai-completions",
		baseUrl: ATLASCLOUD_BASE_URL,
		apiKey: ATLASCLOUD_API_KEY,
		authHeader: true,
		models: ATLASCLOUD_MODELS,
	}
}

export interface InjectAtlasCloudProviderOptions {
	/** When true, write models.json even if it does not exist yet. */
	createIfMissing?: boolean
}

/**
 * Merge Atlas Cloud into models.json as an optional OpenAI-compatible provider.
 *
 * The provider uses `$ATLASCLOUD_API_KEY` so no secret is written to disk. It is
 * safe to run on startup and preserves Kimchi-managed and user-added providers.
 */
export function injectAtlasCloudProvider(modelsJsonPath: string, options: InjectAtlasCloudProviderOptions = {}): void {
	if (!existsSync(modelsJsonPath) && !options.createIfMissing) return

	const config = readModelsConfig(modelsJsonPath)
	const providers = (config.providers as Record<string, unknown> | undefined) ?? {}
	const merged = {
		...config,
		providers: {
			...providers,
			[ATLASCLOUD_PROVIDER_ID]: atlasCloudProviderConfig(),
		},
	}
	writeFileSync(modelsJsonPath, JSON.stringify(merged, null, "\t"), "utf-8")
}

export function readAtlasCloudModelsFromConfig(modelsJsonPath: string): PiModelConfig[] {
	try {
		const raw = readFileSync(modelsJsonPath, "utf-8")
		const parsed = JSON.parse(raw)
		const models = parsed?.providers?.[ATLASCLOUD_PROVIDER_ID]?.models
		if (!Array.isArray(models)) return []
		return models.filter(isPiModelConfig)
	} catch {
		return []
	}
}

export function readAtlasCloudModelMetadata(modelsJsonPath: string): ModelMetadata[] {
	return readAtlasCloudModelsFromConfig(modelsJsonPath).map((model) => ({
		slug: model.id,
		display_name: model.name,
		provider: model.provider ?? ATLASCLOUD_PROVIDER_ID,
		reasoning: model.reasoning,
		input_modalities: model.input,
		is_serverless: true,
		limits: { context_window: model.contextWindow, max_output_tokens: model.maxTokens },
	}))
}
