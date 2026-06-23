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
 */
export function splitModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const slashIdx = ref.indexOf("/")
	if (slashIdx <= 0) return undefined
	const provider = ref.slice(0, slashIdx)
	const modelId = ref.slice(slashIdx + 1)
	if (provider.trim().length === 0 || modelId.trim().length === 0) return undefined
	return { provider, modelId }
}
