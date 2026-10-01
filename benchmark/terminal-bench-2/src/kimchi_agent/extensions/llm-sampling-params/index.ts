import type { BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { Model } from "@earendil-works/pi-ai"

export const ENV_LLM_PARAMS_JSON = "KIMCHI_LLM_PARAMS_JSON"
export const ENV_LLM_PER_MODEL_PARAMS_JSON = "KIMCHI_LLM_PER_MODEL_PARAMS_JSON"

export type SamplingParameters = {
	temperature?: number
	top_p?: number
	top_k?: number
	max_tokens?: number
}

const ALLOWED_KEYS: (keyof SamplingParameters)[] = ["temperature", "top_p", "top_k", "max_tokens"]

export function parseParameters(raw: string | undefined): SamplingParameters {
	if (!raw) return {}
	try {
		const parsed = JSON.parse(raw)
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("parameters must be an object")
		}
		const result: SamplingParameters = {}
		for (const key of ALLOWED_KEYS) {
			if (key in parsed) {
				const value = parsed[key]
				if (typeof value !== "number") {
					throw new Error(`parameter ${key} must be a number, got ${typeof value}`)
				}
				result[key] = value
			}
		}
		return result
	} catch (err) {
		throw new Error(`Invalid LLM parameters JSON: ${err instanceof Error ? err.message : String(err)}`)
	}
}

function modelRef(model: Model<string>): string {
	return `${model.provider}/${model.id}`
}

function applyParameters(
	payload: Record<string, unknown>,
	params: SamplingParameters,
	model: Model<string>,
): Record<string, unknown> {
	if (!params || Object.keys(params).length === 0) return payload

	if (params.temperature !== undefined) {
		payload.temperature = params.temperature
	}
	if (params.top_p !== undefined) {
		payload.top_p = params.top_p
	}
	if (params.top_k !== undefined) {
		payload.top_k = params.top_k
	}
	if (params.max_tokens !== undefined) {
		// compat shape depends on model.api; maxTokensField only exists on OpenAICompletionsCompat.
		const compat = model.compat as { maxTokensField?: "max_completion_tokens" | "max_tokens" } | undefined
		const field = compat?.maxTokensField ?? "max_tokens"
		payload[field] = params.max_tokens
		// Ensure the alternate field is not also present to avoid provider errors.
		const otherField = field === "max_completion_tokens" ? "max_tokens" : "max_completion_tokens"
		delete payload[otherField]
	}

	return payload
}

export default function llmSamplingParamsExtension(pi: ExtensionAPI): void {
	const globalRaw = process.env[ENV_LLM_PARAMS_JSON]
	const perModelRaw = process.env[ENV_LLM_PER_MODEL_PARAMS_JSON]

	let globalParams: SamplingParameters
	let perModelParams: Record<string, SamplingParameters>
	try {
		globalParams = parseParameters(globalRaw)
		const parsedPerModel = perModelRaw ? JSON.parse(perModelRaw) : {}
		if (typeof parsedPerModel !== "object" || parsedPerModel === null || Array.isArray(parsedPerModel)) {
			throw new Error("per-model parameters must be an object")
		}
		perModelParams = parsedPerModel as Record<string, SamplingParameters>
	} catch (err) {
		// Fail fast during startup so misconfiguration is obvious.
		throw new Error(
			`llm-sampling-params extension failed to load: ${err instanceof Error ? err.message : String(err)}`,
		)
	}

	pi.on("before_provider_request", (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
		const payload = event.payload as Record<string, unknown>
		const model = ctx.model as Model<string> | undefined
		if (!model) return payload

		const overrides = perModelParams[modelRef(model)] ?? {}
		const merged: SamplingParameters = { ...globalParams, ...overrides }
		// Mutate event.payload in-place and return the same reference, matching the
		// contract used by src/extensions/tags.ts.
		return applyParameters(payload, merged, model)
	})
}
