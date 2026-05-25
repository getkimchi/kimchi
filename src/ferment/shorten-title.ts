const MAX_TITLE_LENGTH = 60

function stripOuterTitleQuotes(value: string): string {
	const trimmed = value.trim()
	if (trimmed.length >= 2) {
		const first = trimmed[0]
		const last = trimmed[trimmed.length - 1]
		if ((first === `"` && last === `"`) || (first === `'` && last === `'`) || (first === "`" && last === "`")) {
			return trimmed.slice(1, -1).trim()
		}
	}
	return trimmed
}

function truncateTitle(value: string): string {
	if (value.length <= MAX_TITLE_LENGTH) return value
	const truncated = value.slice(0, MAX_TITLE_LENGTH)
	const lastSpace = truncated.lastIndexOf(" ")
	return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim()
}

export function normalizeFermentTitle(value: string | undefined): string | undefined {
	const stripped = stripOuterTitleQuotes(value ?? "")
	const normalized = stripped.replace(/\s+/g, " ").trim()
	if (!normalized) return undefined
	return truncateTitle(normalized)
}

/**
 * Derive a stable draft title without calling a model.
 *
 * LLM naming happens later through `propose_ferment_scoping.title`, using the
 * active Pi turn and normal tool contract. Draft creation must stay local so a
 * cosmetic title can never block Ferment startup.
 */
export async function shortenTitle(rawIntent: string): Promise<string> {
	return normalizeFermentTitle(rawIntent) ?? "Untitled Ferment"
}
