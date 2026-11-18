export interface ProviderRequestLike {
	body?: unknown
}

/** Names that the fake provider actually received, regardless of wire nesting. */
export function requestToolNames(request: ProviderRequestLike): string[] {
	if (typeof request.body !== "object" || request.body === null) return []
	const tools = (request.body as { tools?: unknown }).tools
	if (!Array.isArray(tools)) return []
	return tools.flatMap((tool) => {
		if (typeof tool !== "object" || tool === null) return []
		const direct = (tool as { name?: unknown }).name
		if (typeof direct === "string") return [direct]
		const nested = (tool as { function?: { name?: unknown } }).function?.name
		return typeof nested === "string" ? [nested] : []
	})
}
