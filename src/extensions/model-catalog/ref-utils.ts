import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"

/**
 * Combines model provider and id into a ref string.
 */
export function refFromModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`
}

/** Resolve the exact canonical ref without assuming providers or model IDs contain no slashes. */
export function findModelByRef(
	modelRegistry: Pick<ModelRegistry, "getAvailable">,
	ref: string,
): Model<Api> | undefined {
	return modelRegistry.getAvailable().find((model) => refFromModel(model) === ref)
}

/**
 * Sorted canonical refs of every available model — the shared "list what
 * exists" half of every model-not-found error message.
 */
export function availableModelRefs(modelRegistry: Pick<ModelRegistry, "getAvailable">): string[] {
	return modelRegistry
		.getAvailable()
		.map((m) => refFromModel(m))
		.sort()
}

/**
 * Extract just the model ID from a "provider/model-id" string.
 * Returns the full string if no slash is present.
 */
export function modelIdFromRef(ref: string): string {
	const slashIdx = ref.indexOf("/")
	return slashIdx >= 0 ? ref.slice(slashIdx + 1) : ref
}

/**
 * Extract provider and model ID from a "provider/model-id" string.
 * Returns undefined if the string doesn't contain a slash, or if either
 * the provider or the model ID is empty / whitespace-only.
 *
 * Splits on the FIRST slash: this parse is ambiguous for sub-providers
 * (kimchi-dev/anthropic/claude-opus-4-6) and slashed model ids alike —
 * resolution must go through findModelByRef, which matches the registry's
 * canonical refs exactly.
 */
export function splitModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const slashIdx = ref.indexOf("/")
	if (slashIdx <= 0) return undefined
	const provider = ref.slice(0, slashIdx)
	const modelId = ref.slice(slashIdx + 1)
	if (provider.trim().length === 0 || modelId.trim().length === 0) return undefined
	return { provider, modelId }
}
