import type { Api, Model } from "@mariozechner/pi-ai"
import type { ModelRegistry } from "@mariozechner/pi-coding-agent"
import { KIMCHI_DEV_PROVIDER, MODEL_CAPABILITIES } from "../orchestration/model-registry/index.js"

/**
 * Pick the model to use for the classifier.
 *
 * Strategy:
 *   - kimchi-dev provider: select the lightest-tier model from the
 *     orchestration model registry (MODEL_CAPABILITIES) so classification
 *     runs on the cheapest purpose-built model.
 *   - Any other provider: reuse the current model so users running their
 *     own keys don't need kimchi-dev models configured.
 */
export function resolveClassifierModel(
	currentModel: Model<Api> | undefined,
	modelRegistry: ModelRegistry,
): Model<Api> | undefined {
	if (!currentModel) return undefined

	if (currentModel.provider !== KIMCHI_DEV_PROVIDER) return currentModel

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
