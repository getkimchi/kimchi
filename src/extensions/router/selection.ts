import type { Model } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { AUTO_MODEL_PROVIDER, isAutoModel } from "./constants.js"
import type { RouteRecommendation } from "./router-client.js"

export type RecommendationResult =
	| { ok: true; model: Model<string> }
	| { ok: false; reason: "unavailable_recommendation" | "vision_required" }

export function resolveRecommendation(
	recommendation: RouteRecommendation,
	ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels">,
	requiresVision: boolean,
): RecommendationResult {
	const available = ctx.modelRegistry.getAvailable()
	const availableRefs = new Set(available.map((model) => `${model.provider}\0${model.id}`))
	const candidates = (ctx.scopedModels.length > 0 ? ctx.scopedModels.map((item) => item.model) : available).filter(
		(model) => availableRefs.has(`${model.provider}\0${model.id}`),
	)
	const eligibleById = new Map(
		candidates
			.filter((candidate) => candidate.provider === AUTO_MODEL_PROVIDER && !isAutoModel(candidate))
			.map((candidate) => [candidate.id, candidate] as const),
	)
	const rankedModelIds = [
		recommendation.bestModel,
		...Object.entries(recommendation.probabilities)
			.filter(([modelId]) => modelId !== recommendation.bestModel)
			.sort(([leftId, leftScore], [rightId, rightScore]) => rightScore - leftScore || leftId.localeCompare(rightId))
			.map(([modelId]) => modelId),
	]

	let visionRequired = false
	const seen = new Set<string>()
	for (const modelId of rankedModelIds) {
		if (seen.has(modelId)) continue
		seen.add(modelId)
		const model = eligibleById.get(modelId)
		if (!model) continue
		if (requiresVision && !model.input.includes("image")) {
			visionRequired = true
			continue
		}
		return { ok: true, model }
	}

	return { ok: false, reason: visionRequired ? "vision_required" : "unavailable_recommendation" }
}
