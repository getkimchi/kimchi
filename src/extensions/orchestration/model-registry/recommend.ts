import { MODEL_CAPABILITIES } from "./builtin-models.js"
import { KIMCHI_DEV_PROVIDER } from "./model-registry.js"
import type { ModelCapabilities, ModelStrength, ModelTier } from "./types.js"

export interface RecommendOptions {
	/** Task strengths required — ALL must be present on the model. */
	strengths: ModelStrength[]
	/** Require vision capability. */
	needsVision?: boolean
	/** Tier preference; falls back through tiers if no exact match. Default "standard". */
	preferTier?: ModelTier
	/** Skip ignored entries. Default true. */
	excludeIgnored?: boolean
}

export interface RecommendResult {
	provider: string
	modelId: string
	capabilities: ModelCapabilities
}

/** Tier fallback order: light → standard → heavy. */
const TIER_FALLBACK: Record<ModelTier, ModelTier[]> = {
	light: ["light", "standard", "heavy"],
	standard: ["standard", "heavy", "light"],
	heavy: ["heavy", "standard", "light"],
}

/**
 * Recommend the best model for the given criteria.
 *
 * Algorithm:
 * 1. Filter MODEL_CAPABILITIES entries: must have ALL `strengths`, must satisfy
 *    `needsVision`, must not be ignored (unless excludeIgnored is false).
 * 2. Among matches, prefer the requested tier. If no exact tier match, fall back
 *    in order: light → standard → heavy (or heavy → standard → light etc.).
 * 3. If multiple match the preferred tier, return the first by registry insertion order.
 * 4. If no match, return undefined.
 */
export function recommendModel(opts: RecommendOptions): RecommendResult | undefined {
	const { strengths, needsVision = false, preferTier = "standard", excludeIgnored = true } = opts

	const candidates: Array<{ id: string; capabilities: ModelCapabilities }> = []

	for (const [id, entry] of MODEL_CAPABILITIES.entries()) {
		if (entry === "ignored") {
			if (excludeIgnored) continue
			// If not excluding ignored, skip anyway because we have no capabilities
			continue
		}

		// Must have ALL requested strengths
		if (strengths.length > 0 && !strengths.every((s) => entry.strengths.includes(s))) continue

		// Must satisfy vision requirement
		if (needsVision && !entry.vision) continue

		candidates.push({ id, capabilities: entry })
	}

	if (candidates.length === 0) return undefined

	// Try tiers in fallback order
	const tierOrder = TIER_FALLBACK[preferTier]
	for (const tier of tierOrder) {
		const match = candidates.find((c) => c.capabilities.tier === tier)
		if (match) {
			return {
				provider: KIMCHI_DEV_PROVIDER,
				modelId: match.id,
				capabilities: match.capabilities,
			}
		}
	}

	// Fallback: return first candidate regardless of tier
	const first = candidates[0]
	return {
		provider: KIMCHI_DEV_PROVIDER,
		modelId: first.id,
		capabilities: first.capabilities,
	}
}

/**
 * Pick the best entry from an explicit list of "provider/modelId" strings, ordered by
 * `preferTier` with the same fallback as `recommendModel`. Used by the agents extension's
 * invocation-config to honour a persona's preferTier when selecting from its `models[]`
 * array (instead of blindly taking `models[0]`).
 *
 * Returns undefined when none of the models resolve in MODEL_CAPABILITIES.
 * Unknown entries (not in the registry) are preserved at the end of the candidate list
 * so callers still get a stable fallback when nothing has capability metadata.
 */
export function pickFromModelListByTier(
	models: readonly string[],
	preferTier: ModelTier = "standard",
): string | undefined {
	if (models.length === 0) return undefined

	type Known = { full: string; capabilities: ModelCapabilities }
	const known: Known[] = []
	const unknown: string[] = []

	for (const full of models) {
		const slashIdx = full.indexOf("/")
		const id = slashIdx >= 0 ? full.slice(slashIdx + 1) : full
		const entry = MODEL_CAPABILITIES.get(id)
		if (entry && entry !== "ignored") {
			known.push({ full, capabilities: entry })
		} else {
			unknown.push(full)
		}
	}

	if (known.length === 0) {
		// No capability metadata for any entry — preserve caller's order.
		return models[0]
	}

	const tierOrder = TIER_FALLBACK[preferTier]
	for (const tier of tierOrder) {
		const match = known.find((c) => c.capabilities.tier === tier)
		if (match) return match.full
	}

	// All known entries had unfamiliar tiers — fall back to first known.
	return known[0]?.full ?? unknown[0] ?? models[0]
}
