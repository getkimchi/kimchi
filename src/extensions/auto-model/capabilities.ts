import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export type ModelCapabilities = Pick<Model<Api>, "reasoning" | "thinkingLevelMap" | "contextWindow" | "maxTokens">

export function hasTargetCapabilities(autoModel: ModelCapabilities, target: ModelCapabilities): boolean {
	return (
		autoModel.reasoning === target.reasoning &&
		autoModel.thinkingLevelMap === target.thinkingLevelMap &&
		autoModel.contextWindow === target.contextWindow &&
		autoModel.maxTokens === target.maxTokens
	)
}

export function autoModelForTarget<TApi extends Api>(autoModel: Model<TApi>, target: ModelCapabilities): Model<TApi> {
	return {
		...autoModel,
		reasoning: target.reasoning,
		thinkingLevelMap: target.thinkingLevelMap,
		contextWindow: target.contextWindow,
		maxTokens: target.maxTokens,
	}
}

export async function syncAutoCapabilities<TApi extends Api>(
	pi: ExtensionAPI,
	autoModel: Model<TApi>,
	target: ModelCapabilities,
): Promise<boolean> {
	if (hasTargetCapabilities(autoModel, target)) return true
	return pi.setModel(autoModelForTarget(autoModel, target))
}
