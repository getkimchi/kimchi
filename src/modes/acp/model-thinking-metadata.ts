import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { readModelEffortDefaults } from "../../config.js"
import { isAutoRoutedModel } from "../../extensions/auto-model/constants.js"
import { parseModelThinkingLevel } from "../../model-effort.js"
import { getModelVirtualIdentity } from "../../models.js"
import { refFromModel } from "../../shared/model-ref.js"
import { clampToSelection, thinkingSelection } from "../../thinking-selection.js"
import { type KimchiDevMeta, kimchiDevMetaOf } from "./capabilities.js"

export type ModelThinkingAvailability = "multiple" | "fixed" | "provider-controlled" | "unsupported" | "routed"

export interface ModelThinkingMetadata {
	availability: ModelThinkingAvailability
	levels?: ModelThinkingLevel[]
	currentValue: ModelThinkingLevel | null
	/** Distinguishes built-in Auto, with dynamic route resolution and
	 * attribution, from another managed virtual row. Both are `routed`, but a
	 * boolean would erase Auto's existing client-visible semantics. */
	virtual?: "auto" | "other"
}

type ModelRowConfig = { description?: unknown; virtual?: unknown }

function rowConfig(model: Model<Api>): ModelRowConfig {
	return model as Model<Api> & ModelRowConfig
}

export function modelVirtualIdentity(model: Model<Api>): "auto" | "other" | undefined {
	if (isAutoRoutedModel(model)) return "auto"
	return rowConfig(model).virtual === "other" || getModelVirtualIdentity(refFromModel(model)) === "other"
		? "other"
		: undefined
}

export function configuredModelDescription(model: Model<Api>): string | undefined {
	const description = rowConfig(model).description
	return typeof description === "string" && description.trim() ? description.trim() : undefined
}

export interface ModelThinkingMetadataContext {
	thinkingDefaults: ReturnType<typeof readModelEffortDefaults>
	thinkingByModel: ReadonlyMap<string, ModelThinkingLevel>
	currentModel: AgentSession["model"]
	currentThinkingLevel: AgentSession["thinkingLevel"]
	settingsManager: AgentSession["settingsManager"]
}

/** Build one model row's Thinking metadata for the versioned modelEffort wire
 * slot, using the same authorities as when that model becomes active. */
export function buildModelThinkingMeta(
	model: Model<Api>,
	context: ModelThinkingMetadataContext,
): KimchiDevMeta<{ modelEffort: ModelThinkingMetadata }> {
	const virtual = modelVirtualIdentity(model)
	if (virtual) {
		return kimchiDevMetaOf({ modelEffort: { availability: "routed", currentValue: null, virtual } })
	}

	const modelId = refFromModel(model)
	const isCurrent = context.currentModel !== undefined && refFromModel(context.currentModel) === modelId
	const selection = thinkingSelection(isCurrent && context.currentModel ? context.currentModel : model)
	if (selection.mode !== "levels" || selection.selectable.length === 0) {
		return kimchiDevMetaOf({
			modelEffort: {
				availability: selection.mode === "none" && selection.reasoning ? "provider-controlled" : "unsupported",
				currentValue: null,
			},
		})
	}

	const remembered = context.thinkingByModel.get(modelId)
	const storedThinkingDefault = parseModelThinkingLevel(context.thinkingDefaults[modelId])
	const harnessFallback = isCurrent
		? context.currentThinkingLevel
		: (context.settingsManager.getModelThinkingLevel(model.provider, model.id) ??
			context.settingsManager.getDefaultThinkingLevel() ??
			context.currentThinkingLevel)
	const currentValue = parseModelThinkingLevel(
		clampToSelection(remembered ?? storedThinkingDefault ?? harnessFallback, selection),
	)
	return kimchiDevMetaOf({
		modelEffort: {
			availability: selection.selectable.length === 1 ? "fixed" : "multiple",
			levels: selection.selectable,
			currentValue: currentValue ?? null,
		},
	})
}
