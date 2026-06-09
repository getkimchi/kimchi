import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { KIMCHI_DEV_PROVIDER, MODEL_CAPABILITIES } from "../orchestration/model-registry/index.js"
import type { ModelTier } from "../orchestration/model-registry/types.js"

/** Tier ordering from cheapest to most expensive. */
const TIERS_ASCENDING: ModelTier[] = ["light", "standard", "heavy"]

export interface ClassifierModels {
	/** Primary model to use for classification. */
	primary: Model<Api>
	/**
	 * Fallback model used after the primary exhausts its retries.
	 * Undefined when no suitable alternative exists.
	 */
	fallback: Model<Api> | undefined
}

/**
 * Resolve the primary and fallback models for classification.
 *
 * Both prefer kimchi-dev models, walking tiers light → standard → heavy.
 * Only when no kimchi-dev model is available do they fall back to the
 * cheapest model across all providers.
 *
 * Returns undefined when no model is available at all.
 */
export function resolveClassifierModels(modelRegistry: ModelRegistry): ClassifierModels | undefined {
	const primary = resolveKimchiModel(modelRegistry) ?? cheapestAvailable(modelRegistry)
	if (!primary) return undefined

	const fallback = resolveKimchiModel(modelRegistry, primary.id) ?? cheapestAvailable(modelRegistry, primary.id)

	return { primary, fallback }
}

/**
 * Find the best available kimchi-dev model, excluding `excludeId`.
 * Walks tiers light → standard → heavy and returns the first non-empty tier's
 * cheapest model.
 */
function resolveKimchiModel(modelRegistry: ModelRegistry, excludeId?: string): Model<Api> | undefined {
	for (const tier of TIERS_ASCENDING) {
		for (const [id, caps] of MODEL_CAPABILITIES) {
			if (caps === "ignored") continue
			if (excludeId && id === excludeId) continue
			if (caps.tier !== tier) continue
			const resolved = modelRegistry.find(KIMCHI_DEV_PROVIDER, id)
			if (resolved) return resolved
		}
	}
	return undefined
}

/**
 * Return the cheapest model across all available providers, excluding `excludeId`.
 */
function cheapestAvailable(modelRegistry: ModelRegistry, excludeId?: string): Model<Api> | undefined {
	const candidates = modelRegistry.getAvailable().filter((m) => !excludeId || m.id !== excludeId)
	if (candidates.length === 0) return undefined
	candidates.sort(
		(a, b) => (a.cost?.input ?? 0) + (a.cost?.output ?? 0) - ((b.cost?.input ?? 0) + (b.cost?.output ?? 0)),
	)
	return candidates[0]
}
