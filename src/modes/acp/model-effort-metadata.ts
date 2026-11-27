import type { Api, Model, ModelThinkingLevel as ModelEffortLevel } from "@earendil-works/pi-ai"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import type { readModelEffortDefaults } from "../../config.js"
import { isAutoRoutedModel } from "../../extensions/auto-model/constants.js"
import { parseModelEffortLevel } from "../../model-effort.js"
import { getModelVirtualIdentity } from "../../models.js"
import { refFromModel } from "../../shared/model-ref.js"
import { clampToSelection, thinkingSelection } from "../../thinking-selection.js"
import { type KimchiDevMeta, kimchiDevMetaOf } from "./capabilities.js"

export type ModelEffortAvailability = "multiple" | "fixed" | "provider-controlled" | "unsupported" | "routed"

export interface ModelEffortMetadata {
	availability: ModelEffortAvailability
	levels?: ModelEffortLevel[]
	currentValue: ModelEffortLevel | null
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

export interface ModelEffortMetadataContext {
	effortDefaults: ReturnType<typeof readModelEffortDefaults>
	effortByModel: ReadonlyMap<string, ModelEffortLevel>
	currentModel: AgentSession["model"]
	currentThinkingLevel: AgentSession["thinkingLevel"]
	settingsManager: AgentSession["settingsManager"]
}

/** Build one model row's Effort metadata for the versioned modelEffort wire
 * slot, using the same authorities as when that model becomes active. */
export function buildModelEffortMeta(
	model: Model<Api>,
	context: ModelEffortMetadataContext,
): KimchiDevMeta<{ modelEffort: ModelEffortMetadata }> {
	const virtual = modelVirtualIdentity(model)
	if (virtual) {
		return kimchiDevMetaOf({ modelEffort: { availability: "routed", currentValue: null, virtual } })
	}

	const modelId = refFromModel(model)
	const isCurrent = context.currentModel !== undefined && refFromModel(context.currentModel) === modelId
	const selection = thinkingSelection(isCurrent && context.currentModel ? context.currentModel : model)
	if (selection.mode !== "levels" || selection.selectable.length === 0) {
		// An uncurated all-null level map can yield mode "levels" with no
		// selectable values, without hiding the provider-managed reasoning flag.
		const providerControlled = (selection.mode === "none" && selection.reasoning) || model.reasoning
		return kimchiDevMetaOf({
			modelEffort: {
				availability: providerControlled ? "provider-controlled" : "unsupported",
				currentValue: null,
			},
		})
	}

	const remembered = context.effortByModel.get(modelId)
	const storedDefault = parseModelEffortLevel(context.effortDefaults[modelId])
	const harnessFallback = isCurrent
		? context.currentThinkingLevel
		: (context.settingsManager.getModelThinkingLevel(model.provider, model.id) ??
			context.settingsManager.getDefaultThinkingLevel() ??
			context.currentThinkingLevel)
	const currentValue = parseModelEffortLevel(
		clampToSelection(remembered ?? storedDefault ?? harnessFallback, selection),
	)
	return kimchiDevMetaOf({
		modelEffort: {
			availability: selection.selectable.length === 1 ? "fixed" : "multiple",
			levels: selection.selectable,
			currentValue: currentValue ?? null,
		},
	})
}
