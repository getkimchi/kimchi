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

import type { ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai"
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema"

export const CANONICAL_THINKING_LEVELS = MODEL_THINKING_LEVELS

const LEVEL_RANK = new Map<string, number>(CANONICAL_THINKING_LEVELS.map((level, rank) => [level, rank]))

/**
 * Display names for the canonical thinking levels, as sent in the ACP
 * reasoning_effort option's options[].name — clients render agent-supplied
 * names, so these are kimchi's labels to choose (only the configId and the
 * value ids are load-bearing on the wire). "Extra high" for xhigh follows
 * the ecosystem convention (Qwen Code's ACP adapter, term2); codex-acp
 * capitalizes raw effort ids instead.
 *
 * Keyed by ModelThinkingLevel — the model-level union that includes "off",
 * matching MODEL_THINKING_LEVELS — so a level added upstream fails to
 * compile here until it gets a name, instead of silently rendering the id.
 */
const THINKING_LEVEL_NAMES: Record<ModelThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
}

/** Display name for a thinking level, falling back to the level id when unknown. */
export function thinkingLevelName(level: string): string {
	// Widening is deliberate: selectable sets are typed string[] even though
	// their members are canonical by construction.
	const names = THINKING_LEVEL_NAMES as Record<string, string | undefined>
	return names[level] ?? level
}

/**
 * Filter to known levels and sort by canonical rank. Defensive: the backend
 * guarantees order and completeness, but the flattening layer and models.json
 * cache round-trips shouldn't be trusted blindly.
 */
export function normalizeThinkingLevels(levels: readonly string[]): ModelThinkingLevel[] {
	return [...new Set(levels)]
		.filter((level): level is ModelThinkingLevel => LEVEL_RANK.has(level))
		.sort((a, b) => {
			const rankA = LEVEL_RANK.get(a) ?? -1
			const rankB = LEVEL_RANK.get(b) ?? -1
			return rankA - rankB
		})
}

const EXPLICIT_ONLY_LEVELS = new Set<ModelThinkingLevel>(["xhigh", "max"])

export function deriveThinkingLevelMap(curatedLevels: readonly string[], base: ThinkingLevelMap): ThinkingLevelMap {
	const curated = normalizeThinkingLevels(curatedLevels)
	// Curated-none: thinking exists but offers no distinct levels, so only the
	// default (off) state stays reachable.
	const reachable = new Set<string>(curated.length === 0 ? ["off"] : curated)
	const map: ThinkingLevelMap = {}
	for (const level of CANONICAL_THINKING_LEVELS) {
		const translation = base[level]
		if (!reachable.has(level)) map[level] = null
		else if (translation !== undefined) map[level] = translation
		// pi only offers xhigh and max when the map names them, so a curated level
		// without a base translation is sent verbatim instead of silently dropped.
		else if (EXPLICIT_ONLY_LEVELS.has(level)) map[level] = level
	}
	return map
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
