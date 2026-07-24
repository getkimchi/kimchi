import { existsSync, readFileSync, writeFileSync } from "node:fs"

import type { ModelMetadata, PiModelConfig } from "./models.js"

const ATLASCLOUD_PROVIDER_ID = "atlascloud"
const ATLASCLOUD_BASE_URL = "https://api.atlascloud.ai/v1"
const ATLASCLOUD_API_KEY = "$ATLASCLOUD_API_KEY"

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

	const providers = readAllProviders(modelsJsonPath)
	const merged = {
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
		return models.filter(
			(m): m is PiModelConfig => !!m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string",
		) as PiModelConfig[]
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
