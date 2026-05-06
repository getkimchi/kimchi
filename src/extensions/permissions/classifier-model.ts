import type { Api, Model } from "@mariozechner/pi-ai"
import type { ModelRegistry } from "@mariozechner/pi-coding-agent"
import { KIMCHI_DEV_PROVIDER, MODEL_CAPABILITIES } from "../orchestration/model-registry/index.js"
import type { ModelTier } from "../orchestration/model-registry/types.js"

/** Tier ordering from cheapest to most expensive. */
const TIER_RANK: Record<ModelTier, number> = { light: 0, standard: 1, heavy: 2 }

/**
 * Compute a single scalar cost for a model so we can compare cheapness.
 * Uses the sum of input and output per-token costs.
 */
function modelCost(model: Model<Api>): number {
	return (model.cost?.input ?? 0) + (model.cost?.output ?? 0)
}

/**
 * Pick the model to use for the classifier.
 *
 * The goal is to always use a *different* model than the current one to
 * avoid wasting expensive tokens on a simple classification task. The
 * current model is only returned as a last resort when no other model
 * from the same provider is available.
 *
 * Strategy:
 *   - kimchi-dev provider: select the lightest-tier model from the
 *     orchestration model registry (MODEL_CAPABILITIES). If the current
 *     model is already light-tier, try another light-tier model first,
 *     then step up to the next tier. Falls back to the current model
 *     only when it is the sole available model.
 *   - Any other provider: step down up to two cost tiers within the same
 *     provider. If the current model is already the cheapest, pick the
 *     least expensive model that costs more. Falls back to the current
 *     model only when it is the sole available model.
 */
export function resolveClassifierModel(
	currentModel: Model<Api> | undefined,
	modelRegistry: ModelRegistry,
): Model<Api> | undefined {
	if (!currentModel) return undefined

	if (currentModel.provider !== KIMCHI_DEV_PROVIDER) {
		return cheaperFromSameProvider(currentModel, modelRegistry)
	}

	return resolveKimchiDevClassifier(currentModel, modelRegistry)
}

/**
 * Resolve a classifier model for the kimchi-dev provider.
 *
 * Preference order:
 *   1. A light-tier model that is NOT the current model.
 *   2. Any other light-tier model (even the current one — covered by step 1 only
 *      when there are multiple lights).
 *   3. The next tier up (standard, then heavy) — any model other than current.
 *   4. The current model as an absolute fallback.
 */
function resolveKimchiDevClassifier(currentModel: Model<Api>, modelRegistry: ModelRegistry): Model<Api> {
	const currentCaps = MODEL_CAPABILITIES.get(currentModel.id)
	const currentTier = currentCaps !== undefined && currentCaps !== "ignored" ? currentCaps.tier : undefined

	// 1. Try light-tier models, preferring one that is NOT the current model.
	const lightModels: Model<Api>[] = []
	for (const [id, caps] of MODEL_CAPABILITIES) {
		if (caps === "ignored") continue
		if (caps.tier === "light") {
			const resolved = modelRegistry.find(KIMCHI_DEV_PROVIDER, id)
			if (resolved) lightModels.push(resolved)
		}
	}

	const differentLight = lightModels.find((m) => m.id !== currentModel.id)
	if (differentLight) return differentLight

	// Current model is the only light-tier model — if current is already
	// light-tier, try the next tier up instead.
	if (currentTier === "light") {
		const nextUp = findNextTierUp(currentModel, modelRegistry, "light")
		if (nextUp) return nextUp
	}

	// Return the single light-tier model if one exists (even if it is current).
	if (lightModels.length > 0) return lightModels[0]

	// No light-tier available at all — fall back to current.
	return currentModel
}

/**
 * Find the lowest-cost model at the next tier above `belowTier` that is
 * not the current model.
 *
 * Tier ordering: light < standard < heavy.
 */
function findNextTierUp(
	currentModel: Model<Api>,
	modelRegistry: ModelRegistry,
	belowTier: ModelTier,
): Model<Api> | undefined {
	const tiersAscending: ModelTier[] = ["light", "standard", "heavy"]
	const startRank = TIER_RANK[belowTier] + 1

	for (const tier of tiersAscending) {
		if (TIER_RANK[tier] < startRank) continue
		for (const [id, caps] of MODEL_CAPABILITIES) {
			if (caps === "ignored") continue
			if (caps.tier === tier && id !== currentModel.id) {
				const resolved = modelRegistry.find(KIMCHI_DEV_PROVIDER, id)
				if (resolved) return resolved
			}
		}
	}

	return undefined
}

/**
 * Among all available models from the same provider, step down up to two
 * cost tiers from `currentModel`.
 *
 * If no cheaper model exists, pick the least more expensive model to
 * still avoid reusing the current model. Falls back to the current model
 * only when it is the sole available model from that provider.
 */
function cheaperFromSameProvider(currentModel: Model<Api>, modelRegistry: ModelRegistry): Model<Api> {
	const currentCost = modelCost(currentModel)

	const sameProvider = modelRegistry.getAvailable().filter((m) => m.provider === currentModel.provider)

	// Collect models that are strictly cheaper, sorted descending by cost.
	const cheaper = sameProvider.filter((m) => modelCost(m) < currentCost).sort((a, b) => modelCost(b) - modelCost(a))

	if (cheaper.length > 0) {
		// Step down up to 2 tiers: index 0 = one step, index 1 = two steps.
		const stepsDown = Math.min(1, cheaper.length - 1)
		return cheaper[stepsDown]
	}

	// No cheaper model — pick the least more expensive alternative to avoid
	// reusing the current model.
	const moreExpensive = sameProvider
		.filter((m) => m.id !== currentModel.id && modelCost(m) >= currentCost)
		.sort((a, b) => modelCost(a) - modelCost(b))

	if (moreExpensive.length > 0) return moreExpensive[0]

	// Sole model in the provider — no choice.
	return currentModel
}
