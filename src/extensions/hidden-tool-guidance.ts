import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { revealDeferredTool } from "./deferred-reveal.js"

/**
 * Two duties around "Tool X not found" errors:
 *
 * 1. Rewrite the bare upstream error into actionable guidance (the model
 *    otherwise diagnoses a tool outage and retries the same call for dozens
 *    of turns).
 * 2. If the missing tool belongs to a visibility-deferred suite (DAP
 *    entry/session tools, Agent continuations), reveal that suite so the
 *    model's retry works. Deferred tools have visible anchors that reveal
 *    them in the normal flow, but paths like a resumed session can reach
 *    them first. The reveal goes through the suite's own deferral
 *    (deferred-reveal) so its visibility vote is released — a bare
 *    setActiveTools would be undone by the next profile/visibility
 *    recompute. Tools hidden for any other reason (platform or print gates,
 *    plan mode) and hallucinated names are never revealed.
 *
 * Note: message_end (toolResult) is the first event site that mutates the
 * active tool set rather than just text — it fires after tool execution,
 * before the next LLM request, so the revealed tool is on the wire next
 * turn.
 */
export default function hiddenToolGuidanceExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role !== "toolResult" || !message.isError) return

		const block = message.content.length === 1 ? message.content[0] : undefined
		if (block?.type !== "text" || block.text.trim() !== `Tool ${message.toolName} not found`) {
			return
		}

		const revealed = revealDeferredTool(message.toolName)

		return {
			message: {
				...message,
				// The backstop reveal must also stamp the in-band load marker so
				// providers with native deferred-tool loading keep the revealed
				// tool out of the wire `tools` array (cache-stable surface).
				...(revealed && { addedToolNames: [...revealed] }),
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
