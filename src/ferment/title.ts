import { stripOuterQuotes } from "./text.js"

const MAX_TITLE_LENGTH = 60

function truncateTitle(value: string): string {
	if (value.length <= MAX_TITLE_LENGTH) return value
	const truncated = value.slice(0, MAX_TITLE_LENGTH)
	const lastSpace = truncated.lastIndexOf(" ")
	return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim()
}

export function normalizeFermentTitle(value: string | undefined): string | undefined {
	const stripped = stripOuterQuotes(value ?? "")
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
export function deriveDraftFermentTitle(rawIntent: string): string {
	return normalizeFermentTitle(rawIntent) ?? "Untitled Ferment"
}
