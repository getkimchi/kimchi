import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { splitModelRef } from "../orchestration/model-ref-utils.js"

export const DEFAULT_CLASSIFIER_CANDIDATE_REFS = [
	"kimchi-dev/deepseek-v4-flash-0731",
	"kimchi-dev/glm-5.3-flash",
	"kimchi-dev/minimax-m3",
] as const

/** The only classifier seam that knows the catalog's model preferences. */
export function resolveClassifierCandidates(registry: Pick<ModelRegistry, "find">): {
	candidates: Model<Api>[]
	missingRefs: string[]
} {
	const candidates: Model<Api>[] = []
	const missingRefs: string[] = []
	for (const ref of DEFAULT_CLASSIFIER_CANDIDATE_REFS) {
		const parsed = splitModelRef(ref)
		const model = parsed && registry.find(parsed.provider, parsed.modelId)
		if (model) candidates.push(model)
		else missingRefs.push(ref)
	}
	return { candidates, missingRefs }
}
