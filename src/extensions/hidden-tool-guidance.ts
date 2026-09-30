import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Two duties around "Tool X not found" errors:
 *
 * 1. Rewrite the bare upstream error into actionable guidance (the model
 *    otherwise diagnoses a tool outage and retries the same call for dozens
 *    of turns).
 * 2. If the missing tool is REGISTERED — i.e. one of the visibility-deferred
 *    suites (DAP entry/session tools, Agent continuations) — reveal it
 *    so the model's retry actually works. Deferred tools have visible
 *    anchors that reveal them in the normal flow, but paths like a resumed
 *    session can reach them first.
 *    We re-surface directly via setActiveTools: visibility votes are
 *    per-extension owned (this extension cast no vote, so visibility.enable
 *    is a no-op here). Genuinely unknown names don't match anything
 *    registered, so this never reveals hallucinated tools.
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

		const revealed =
			pi.getAllTools().some((t) => t.name === message.toolName) && !pi.getActiveTools().includes(message.toolName)
		if (revealed) {
			pi.setActiveTools([...pi.getActiveTools(), message.toolName])
		}

		return {
			message: {
				...message,
				// The backstop reveal must also stamp the in-band load marker so
				// providers with native deferred-tool loading keep the revealed
				// tool out of the wire `tools` array (cache-stable surface).
				...(revealed && { addedToolNames: [message.toolName] }),
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
