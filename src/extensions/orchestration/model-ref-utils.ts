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
 * Returns undefined if the string doesn't contain a slash.
 */
export function splitModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const slashIdx = ref.indexOf("/")
	if (slashIdx <= 0) return undefined
	return {
		provider: ref.slice(0, slashIdx),
		modelId: ref.slice(slashIdx + 1),
	}
}
