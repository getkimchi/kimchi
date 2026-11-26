import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { isAutoRoutedModel } from "../../extensions/auto-model/constants.js"
import { getModelEffortDefault, parseModelThinkingLevel, type SessionAppMode } from "../../model-effort.js"
import { getModelSearchAliases, getModelVirtualIdentity } from "../../models.js"
import { refFromModel } from "../../shared/model-ref.js"
import { clampToSelection, thinkingSelection } from "../../thinking-selection.js"
import { type KimchiDevMeta, kimchiDevMetaOf } from "./capabilities.js"

export type ModelEffortAvailability = "multiple" | "fixed" | "provider-controlled" | "unsupported" | "routed"

export interface ModelEffortMetadata {
	availability: ModelEffortAvailability
	levels?: ModelThinkingLevel[]
	currentValue: ModelThinkingLevel | null
	defaultValue: ModelThinkingLevel | null
	searchAliases?: string[]
	virtual?: "auto" | "other"
}

type ModelRowConfig = { description?: unknown; searchAliases?: unknown; virtual?: unknown }

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

function modelSearchAliases(model: Model<Api>): string[] | undefined {
	const configured = rowConfig(model).searchAliases
	const candidates = Array.isArray(configured) ? configured : (getModelSearchAliases(refFromModel(model)) ?? [])
	const aliases = [
		...new Set(candidates.filter((alias): alias is string => typeof alias === "string").map((alias) => alias.trim())),
	].filter(Boolean)
	return aliases.length > 0 ? aliases : undefined
}

function withSearchAliases(metadata: ModelEffortMetadata, model: Model<Api>): ModelEffortMetadata {
	const searchAliases = modelSearchAliases(model)
	return searchAliases ? { ...metadata, searchAliases } : metadata
}

export interface ModelEffortMetadataContext {
	appMode?: SessionAppMode
	effortByModel: ReadonlyMap<string, ModelThinkingLevel>
	currentModel: AgentSession["model"]
	currentThinkingLevel: AgentSession["thinkingLevel"]
	settingsManager: AgentSession["settingsManager"]
}

function availableDefault(
	stored: ModelThinkingLevel | undefined,
	selection: ReturnType<typeof thinkingSelection>,
): ModelThinkingLevel | null {
	return stored ? (parseModelThinkingLevel(clampToSelection(stored, selection)) ?? null) : null
}

/** Build one model row's negotiated Effort data from the same selection and
 * fallback authorities used when that model becomes active in this session. */
export function buildModelEffortMeta(
	model: Model<Api>,
	context: ModelEffortMetadataContext,
): KimchiDevMeta<{ modelEffort: ModelEffortMetadata }> {
	const virtual = modelVirtualIdentity(model)
	if (virtual) {
		return kimchiDevMetaOf({
			modelEffort: withSearchAliases(
				{ availability: "routed", currentValue: null, defaultValue: null, virtual },
				model,
			),
		})
	}

	const modelId = refFromModel(model)
	const isCurrent = context.currentModel !== undefined && refFromModel(context.currentModel) === modelId
	const selection = thinkingSelection(isCurrent && context.currentModel ? context.currentModel : model)
	if (selection.mode !== "levels" || selection.selectable.length === 0) {
		return kimchiDevMetaOf({
			modelEffort: withSearchAliases(
				{
					availability: selection.mode === "none" && selection.reasoning ? "provider-controlled" : "unsupported",
					currentValue: null,
					defaultValue: null,
				},
				model,
			),
		})
	}

	const remembered = context.effortByModel.get(modelId)
	const storedDefault = getModelEffortDefault(context.appMode, modelId)
	const harnessFallback = isCurrent
		? context.currentThinkingLevel
		: (context.settingsManager.getModelThinkingLevel(model.provider, model.id) ??
			context.settingsManager.getDefaultThinkingLevel() ??
			context.currentThinkingLevel)
	const currentValue = parseModelThinkingLevel(
		clampToSelection(remembered ?? storedDefault ?? harnessFallback, selection),
	)
	return kimchiDevMetaOf({
		modelEffort: withSearchAliases(
			{
				availability: selection.selectable.length === 1 ? "fixed" : "multiple",
				levels: selection.selectable,
				currentValue: currentValue ?? null,
				defaultValue: availableDefault(storedDefault, selection),
			},
			model,
		),
	})
}
