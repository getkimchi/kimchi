/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 *
 * Model spec format is always `<provider>/<model>` — explicit per provider.
 */

export interface ModelEntry {
	id: string
	name: string
	provider: string
}

export interface ModelRegistry {
	find(provider: string, modelId: string): unknown
	getAll(): unknown[]
	getAvailable?(): unknown[]
}

/**
 * Resolve a model string to a Model instance.
 * Tries exact match first ("provider/modelId"), then fuzzy match against all available models.
 * Returns the Model on success, or an error message string on failure.
 *
 * Model spec must be in `<provider>/<model>` format for exact matching.
 */
export function resolveModel(input: string, registry: ModelRegistry): unknown | string {
	// Available models (those with auth configured)
	const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[]
	const availableSet = new Set(all.map((m) => `${m.provider}/${m.id}`.toLowerCase()))

	// 1. Exact match: "provider/modelId" — only if available (has auth)
	const slashIdx = input.indexOf("/")
	if (slashIdx !== -1) {
		const provider = input.slice(0, slashIdx)
		const modelId = input.slice(slashIdx + 1)
		if (availableSet.has(input.toLowerCase())) {
			const found = registry.find(provider, modelId)
			if (found) return found
		}
	}

	// 2. Fuzzy match against available models
	const query = input.toLowerCase()

	let bestMatch: ModelEntry | undefined
	let bestScore = 0

	for (const m of all) {
		const id = m.id.toLowerCase()
		const name = m.name.toLowerCase()
		const full = `${m.provider}/${m.id}`.toLowerCase()

		let score = 0
		if (id === query || full === query) {
			score = 100
		} else if (id.includes(query) || full.includes(query)) {
			score = 60 + (query.length / id.length) * 30
		} else if (name.includes(query)) {
			score = 40 + (query.length / name.length) * 20
		} else if (
			query
				.split(/[\s\-/]+/)
				.every((part) => id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
		) {
			score = 20
		}

		if (score > bestScore) {
			bestScore = score
			bestMatch = m
		}
	}

	if (bestMatch && bestScore >= 20) {
		const found = registry.find(bestMatch.provider, bestMatch.id)
		if (found) return found
	}

	// 3. No match — list available models
	const modelList = all
		.map((m) => `  ${m.provider}/${m.id}`)
		.sort()
		.join("\n")
	return `Model not found: "${input}".\n\nAvailable models:\n${modelList}`
}
