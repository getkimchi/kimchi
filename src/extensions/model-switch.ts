import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { sessionHasImages } from "./model-guard.js"
import { MODEL_CAPABILITIES } from "./orchestration/model-registry/builtin-models.js"
import type { ModelTier } from "./orchestration/model-registry/types.js"

/** Tier ordering for downgrade detection: higher index = lower tier. */
const TIER_ORDER: ModelTier[] = ["heavy", "standard", "light"]

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
			if (usage?.tokens != null && usage.tokens > target.contextWindow) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Current context (${usage.tokens} tokens) exceeds the target model "${model}" context window of ${target.contextWindow} tokens. Switch rejected to prevent data loss. Compact or truncate the conversation first.`,
						},
					],
					details: null,
				}
			}

			// Vision compatibility guard
			if (sessionHasImages() && !target.input.includes("image")) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Current conversation contains images but target model "${model}" does not support vision input. Switch to a vision-capable model or start a new session.`,
						},
					],
					details: null,
				}
			}

			// Tier-downgrade warning (informational, not a blocker)
			const currentTier = getModelTier(ctx.model)
			const targetTier = getModelTier(target)
			const tierWarning =
				currentTier && targetTier && TIER_ORDER.indexOf(currentTier) < TIER_ORDER.indexOf(targetTier)
					? `\n\nNote: Switched from a ${currentTier}-tier to a ${targetTier}-tier model. Reasoning and planning quality may be reduced for complex tasks.`
					: ""

			const ok = await pi.setModel(target)
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
						text: `Switched to model ${target.provider}/${target.id} (${target.name})${tierWarning}`,
					},
				],
				details: null,
			}
		},
	})
}
