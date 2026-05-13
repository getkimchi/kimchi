import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

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
					{ type: "text" as const, text: `Switched to model ${target.provider}/${target.id} (${target.name})` },
				],
				details: null,
			}
		},
	})
}
