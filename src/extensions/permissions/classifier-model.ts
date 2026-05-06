import type { Api, Model } from "@mariozechner/pi-ai"
import type { ModelRegistry } from "@mariozechner/pi-coding-agent"
import { KIMCHI_DEV_PROVIDER, MODEL_CAPABILITIES } from "../orchestration/model-registry/index.js"

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
 * Strategy:
 *   - kimchi-dev provider: select the lightest-tier model from the
 *     orchestration model registry (MODEL_CAPABILITIES) so classification
 *     runs on the cheapest purpose-built model.
 *   - Any other provider: step down up to two cost tiers within the same
 *     provider. This saves tokens on classification while still picking a
 *     model capable enough for the task. Falls back to the current model
 *     when no cheaper alternative exists.
 */
export function resolveClassifierModel(
	currentModel: Model<Api> | undefined,
	modelRegistry: ModelRegistry,
): Model<Api> | undefined {
	if (!currentModel) return undefined

	if (currentModel.provider !== KIMCHI_DEV_PROVIDER) {
		return cheaperFromSameProvider(currentModel, modelRegistry)
	}

	// Find a light-tier model from the orchestration capability map.
	for (const [id, caps] of MODEL_CAPABILITIES) {
		if (caps === "ignored") continue
		if (caps.tier === "light") {
			const resolved = modelRegistry.find(KIMCHI_DEV_PROVIDER, id)
			if (resolved) return resolved
		}
	}

	// No light-tier model available — fall back to current model.
	return currentModel
}

/**
 * Among all available models from the same provider, step down up to two
 * cost tiers from `currentModel`.
 *
 * Sorts same-provider models by descending cost, finds the current model's
 * position, then returns the model two ranks below it (or the cheapest
 * available if fewer than two cheaper models exist).
 *
 * Falls back to `currentModel` when no cheaper alternative is found.
 */
function cheaperFromSameProvider(currentModel: Model<Api>, modelRegistry: ModelRegistry): Model<Api> {
	const currentCost = modelCost(currentModel)

	// Collect same-provider models that are strictly cheaper, sorted descending by cost.
	const cheaper = modelRegistry
		.getAvailable()
		.filter((m) => m.provider === currentModel.provider && modelCost(m) < currentCost)
		.sort((a, b) => modelCost(b) - modelCost(a))

	if (cheaper.length === 0) return currentModel

	// Step down up to 2 tiers: index 0 = one step, index 1 = two steps.
	const stepsDown = Math.min(1, cheaper.length - 1)
	return cheaper[stepsDown]
}
