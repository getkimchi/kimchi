/**
 * Canonical thinking levels and the display cell shared by the `list_models`
 * tool (src/extensions/model-list.ts) and the /model selector table
 * (src/model-selector-table.ts).
 *
 * Wire contract (backend /v1/models/metadata) — tri-state curation on
 * `thinking_levels: string[]`: the field is omitted for uncurated models
 * (clients must not infer levels), served as the explicit empty array for
 * curated models whose thinking offers no distinct levels (provider default
 * applies, no level controls), and populated with the curated levels
 * otherwise (canonical rank order).
 */

/** Canonical level order: `off < minimal < low < medium < high < xhigh < max`. */
export const CANONICAL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

const LEVEL_RANK = new Map<string, number>(CANONICAL_THINKING_LEVELS.map((level, rank) => [level, rank]))

/**
 * Filter to known levels and sort by canonical rank. Defensive: the backend
 * guarantees order and completeness, but the flattening layer and models.json
 * cache round-trips shouldn't be trusted blindly.
 */
export function normalizeThinkingLevels(levels: readonly string[]): string[] {
	return [...new Set(levels)]
		.filter((level): level is string => LEVEL_RANK.has(level))
		.sort((a, b) => {
			const rankA = LEVEL_RANK.get(a) ?? -1
			const rankB = LEVEL_RANK.get(b) ?? -1
			return rankA - rankB
		})
}

/**
 * The THINKING cell for a model, implementing the tri-state curation:
 *
 * - populated levels render as a comma+space list in canonical order
 *   (including the bare `off` of a curated no-thinking model);
 * - the curated empty array ("thinking exists but offers no distinct
 *   levels") renders `on` when the model reasons — the provider default
 *   applies at runtime — and `off` otherwise;
 * - an absent field means NOT curated and levels must not be inferred: a
 *   reasoning model renders "not curated" (levels unknown), a non-reasoning
 *   model `off` (a hard fact from the metadata, not a curation inference).
 */
export function thinkingColumnValue(levels: readonly string[] | undefined, reasoning: boolean): string {
	if (levels === undefined) return reasoning ? "not curated" : "off"
	const normalized = normalizeThinkingLevels(levels)
	if (normalized.length > 0) return normalized.join(", ")
	return reasoning ? "on" : "off"
}
