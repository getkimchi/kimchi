import type { ModelMetadata } from "../../models.js"
import { BASE_URL } from "../constants.js"

/**
 * Build the OpenCode provider config block for the kimchi provider.
 * OpenCode pickers fail silently on unknown keys, so keep the schema
 * exact.
 *
 * The shape is `existing.provider.kimchi = …` in opencode.json. All
 * available models from the API are included — OpenCode's picker will
 * surface whichever ones it supports.
 */
export function openCodeProviderConfig(apiKey: string, models: readonly ModelMetadata[]): Record<string, unknown> {
	return {
		npm: "@ai-sdk/openai-compatible",
		name: "Kimchi",
		options: {
			baseURL: BASE_URL,
			litellmProxy: true,
			apiKey,
		},
		models: Object.fromEntries(models.map((m) => [m.slug, openCodeModelEntry(m)])),
	}
}

function openCodeModelEntry(model: ModelMetadata): Record<string, unknown> {
	return {
		name: model.slug,
		// `tool_call` is not in ModelMetadata; all models served through kimchi support it.
		tool_call: true,
		reasoning: model.reasoning,
		limit: {
			context: model.limits.context_window,
			output: model.limits.max_output_tokens,
		},
	}
}
