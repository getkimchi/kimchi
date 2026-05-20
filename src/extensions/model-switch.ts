import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { isRestoringModel } from "./ferment/state.js"
import { contextFitsModel, getSafeContextWindow, sessionHasImages } from "./model-guard.js"
import { MODEL_CAPABILITIES } from "./orchestration/model-registry/builtin-models.js"
import type { ModelTier } from "./orchestration/model-registry/types.js"

/** Tier ordering for downgrade detection: higher index = lower tier. */
const TIER_ORDER: ModelTier[] = ["heavy", "standard", "light"]

/** Prevents model_select handler from re-checking what set_model tool already validated. */
let suppressModelSelectGuard = false

/** Recursion guard — true while our own revert is in progress. */
let isRevertingModel = false

/** Resets module state between tests. */
export function __resetModelSwitchStateForTest(): void {
	suppressModelSelectGuard = false
	isRevertingModel = false
}

/**
 * Extract tier from a model descriptor via MODEL_CAPABILITIES.
 * In tests, pass the capabilities map explicitly to avoid module-isolation issues.
 */
export function getModelTier(
	model: Model<Api> | undefined,
	capsMap: ReadonlyMap<string, unknown> = MODEL_CAPABILITIES,
): ModelTier | undefined {
	if (!model) return undefined
	const caps = capsMap.get(model.id)
	if (!caps || caps === "ignored") return undefined
	return (caps as { tier: ModelTier }).tier
}

export default function modelSwitchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "set_model",
		label: "Switch Model",
		description:
			'Change the active AI model to a different one. Provide the model in provider/id format, e.g. "kimchi-dev/kimi-k2.6". Uses pi.setModel() internally.',
		parameters: Type.Object({
			model: Type.String({
				description:
					'Target model identifier in "provider/modelId" format (e.g. "kimchi-dev/kimi-k2.6", "anthropic/claude-sonnet-4-20250514").',
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { model } = params
			const parts = model.split("/")
			if (parts.length !== 2 || !parts[0] || !parts[1]) {
				const available =
					ctx.modelRegistry
						?.getAvailable()
						?.map((m) => `${m.provider}/${m.id}`)
						?.sort() ?? []
				return {
					content: [
						{
							type: "text" as const,
							text: `Invalid model format: "${model}". Expected "provider/modelId".\n\nAvailable models:\n${available.join("\n")}`,
						},
					],
					details: null,
				}
			}

			const [provider, modelId] = parts
			const target = ctx.modelRegistry?.find(provider, modelId)

			if (!target) {
				const available =
					ctx.modelRegistry
						?.getAvailable()
						?.map((m) => `${m.provider}/${m.id}`)
						?.sort() ?? []
				return {
					content: [
						{
							type: "text" as const,
							text: `Model not found: ${provider}/${modelId}\n\nAvailable models:\n${available.join("\n")}`,
						},
					],
					details: null,
				}
			}

			const usage = ctx.getContextUsage()
			if (usage?.tokens != null && !contextFitsModel(usage.tokens, target.contextWindow)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Current context (${usage.tokens} tokens) exceeds the target model "${model}" safe context limit (${getSafeContextWindow(target.contextWindow)} of ${target.contextWindow} tokens). Switch rejected to prevent data loss. Use /compact to reduce context size, then retry.`,
						},
					],
					details: null,
				}
			}

			// Vision compatibility guard
			if (sessionHasImages() && !target.input.includes("image") && ctx.model?.input.includes("image")) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Current conversation contains images but target model "${model}" does not support vision input. Run /strip-images to replace images with text descriptions, then retry.`,
						},
					],
					details: null,
				}
			}

			let ok: boolean
			suppressModelSelectGuard = true
			try {
				ok = await pi.setModel(target)
			} finally {
				suppressModelSelectGuard = false
			}
			if (!ok) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Failed to switch to ${provider}/${modelId} — no API key available for this model's provider.`,
						},
					],
					details: null,
				}
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `Switched to model ${target.provider}/${target.id} (${target.name})`,
					},
				],
				details: null,
			}
		},
	})

	pi.on?.("model_select", async (event, ctx) => {
		// Skip if a revert is already in progress
		if (isRevertingModel) return
		// Skip if set_model tool initiated this (already validated)
		if (suppressModelSelectGuard) return
		// cycle and restore are handled by ctrl+p / session recovery already
		if (event.source === "cycle" || event.source === "restore") return
		// Skip if ferment is reverting (its own rollback path)
		if (isRestoringModel()) return
		// Nothing to revert to
		if (!event.previousModel) return

		const usage = ctx.getContextUsage?.()

		// Context window guard — block if current tokens exceed target safe context window
		if (usage?.tokens != null && !contextFitsModel(usage.tokens, event.model.contextWindow)) {
			isRevertingModel = true
			await pi.setModel(event.previousModel)
			isRevertingModel = false
			ctx.ui?.notify(
				`Current context (${usage.tokens} tokens) exceeds the ${event.model.id} safe context limit (${getSafeContextWindow(event.model.contextWindow)} of ${event.model.contextWindow} tokens). Switch rejected — use /compact to reduce context size, then try again.`,
				"error",
			)
			return
		}

		// Vision guard — block if session has images but target lacks vision support
		if (sessionHasImages() && !event.model.input.includes("image") && event.previousModel?.input.includes("image")) {
			isRevertingModel = true
			await pi.setModel(event.previousModel)
			isRevertingModel = false
			ctx.ui?.notify(
				`Session contains images but ${event.model.id} does not support vision. Run /strip-images to unlock non-vision models, or use a vision-capable model.`,
				"error",
			)
			return
		}

		// Tier-downgrade info — non-blocking
		const prevTier = getModelTier(event.previousModel as never, MODEL_CAPABILITIES)
		const nextTier = getModelTier(event.model as never, MODEL_CAPABILITIES)
		if (prevTier && nextTier && TIER_ORDER.indexOf(prevTier) < TIER_ORDER.indexOf(nextTier)) {
			ctx.ui?.notify(
				`Switching from ${prevTier}-tier to ${nextTier}-tier model. Reasoning quality may be reduced for complex tasks.`,
				"info",
			)
		}
	})
}
