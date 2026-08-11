import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function hiddenToolGuidanceExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role !== "toolResult" || !message.isError) return

		const block = message.content.length === 1 ? message.content[0] : undefined
		if (block?.type !== "text" || block.text.trim() !== `Tool ${message.toolName} not found`) {
			return
		}

		return {
			message: {
				...message,
				content: [
					{
						...block,
						text: `Tool ${message.toolName} not found: "${message.toolName}" is not available in the current tool list. Continue with an available tool and retry only if "${message.toolName}" appears there later.`,
					},
				],
			},
		}
	})
}
