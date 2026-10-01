import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { getModelDescription } from "../models.js"
import { isAutoRoutedModel, splitModelDisplayName } from "./auto-model/constants.js"
import { resolveEffectiveModel } from "./auto-model/state.js"
import { MODEL_CAPABILITIES } from "./orchestration/model-registry/builtin-models.js"
import type { ModelCapabilities } from "./orchestration/model-registry/types.js"

/** Longest one-line description we render; longer text is truncated to keep the listing one row per model. */
const MAX_DESCRIPTION_LENGTH = 160

/** Combine provider and id into a "provider/modelId" ref string. */
export function modelRefFromModel(model: Model<Api>): string {
	return `${model.provider}/${model.id}`
}

/**
 * Collapse any whitespace (including newlines) and cap the description so
 * multi-line capability texts stay on a single, bounded listing row.
 */
function truncateDescription(description: string): string {
	const oneLine = description.replace(/\s+/g, " ").trim()
	if (oneLine.length <= MAX_DESCRIPTION_LENGTH) return oneLine
	return `${oneLine.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
}

/**
 * Resolve a human-facing description for a model, or undefined when none is
 * known. Priority: the selector description registry (backend metadata + Auto
 * fallback) first, then the local orchestration capability knowledge base, and
 * finally the " — " sentinel suffix of the registered display name.
 *
 * The lookup functions are injectable so tests stay deterministic without a
 * populated global description registry (see getModelTier's capsMap default).
 */
export function resolveModelDescription(
	model: Model<Api>,
	getDescription: (ref: string) => string | undefined = getModelDescription,
	capsMap: ReadonlyMap<string, ModelCapabilities | "ignored"> = MODEL_CAPABILITIES,
): string | undefined {
	const registered = getDescription(modelRefFromModel(model))
	if (registered) return registered
	const caps = capsMap.get(model.id)
	if (caps && caps !== "ignored") return caps.description
	return splitModelDisplayName(model.name).description
}

/**
 * The `Current model:` header line. When the active model is auto-routed, it
 * names the concrete model it currently routes to; the resolved model's own
 * characteristics (context window, vision, reasoning) are read from its row
 * in the table below.
 */
export function formatCurrentModelLine(model: Model<Api>, sessionId: string): string {
	let line = `Current model: ${modelRefFromModel(model)}`
	if (isAutoRoutedModel(model)) {
		const resolved = resolveEffectiveModel(model, sessionId)
		if (resolved && resolved !== model) {
			line += ` (routed to: ${modelRefFromModel(resolved)})`
		}
	}
	return line
}

/** Column labels for the listing table; body rows omit them via formatModelListingLine. */
export const MODEL_LISTING_HEADER = "model | context | vision | reasoning | description"

/**
 * One pipe-separated listing row: `model | context | vision | reasoning`,
 * plus a trailing description segment when available.
 */
export function formatModelListingLine(model: Model<Api>, description?: string): string {
	const parts = [
		modelRefFromModel(model),
		String(model.contextWindow),
		model.input.includes("image") ? "yes" : "no",
		model.reasoning ? "yes" : "no",
	]
	if (description) parts.push(truncateDescription(description))
	return parts.join(" | ")
}

export default function modelListExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "list_models",
		label: "List Models",
		description:
			"List available models with their characteristics as a table: model (provider/modelId ref), context window, vision, reasoning, and description when available. Use the ref (provider/modelId) values from this list with the set_model tool to switch models, or as the model parameter of the Agent tool when spawning subagents.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
			const lines: string[] = []
			const current = ctx.model
			if (current) lines.push(formatCurrentModelLine(current, ctx.sessionManager.getSessionId()), "")

			const models = ctx.modelRegistry.getAvailable()
			if (models.length === 0) {
				lines.push("No models available.")
			} else {
				const sorted = [...models].sort((a, b) => modelRefFromModel(a).localeCompare(modelRefFromModel(b)))
				lines.push(MODEL_LISTING_HEADER)
				for (const model of sorted) {
					lines.push(formatModelListingLine(model, resolveModelDescription(model)))
				}
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: null,
			}
		},
	})
}
