import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/**
 * Two duties around "Tool X not found" errors:
 *
 * 1. Rewrite the bare upstream error into actionable guidance (the model
 *    otherwise diagnoses a tool outage and retries the same call for dozens
 *    of turns).
 * 2. If the missing tool is REGISTERED — i.e. one of the visibility-deferred
 *    suites (DAP, bash_control, web_fetch, Agent continuations) — reveal it
 *    so the model's retry actually works. Deferred tools have visible
 *    anchors that reveal them in the normal flow, but paths like a resumed
 *    session or a web_fetch-before-web_search call can reach them first.
 *    We re-surface directly via setActiveTools: visibility votes are
 *    per-extension owned (this extension cast no vote, so visibility.enable
 *    is a no-op here). Genuinely unknown names don't match anything
 *    registered, so this never reveals hallucinated tools.
 */
export default function hiddenToolGuidanceExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event) => {
		const message = event.message
		if (message.role !== "toolResult" || !message.isError) return

		const block = message.content.length === 1 ? message.content[0] : undefined
		if (block?.type !== "text" || block.text.trim() !== `Tool ${message.toolName} not found`) {
			return
		}

		try {
			if (
				pi.getAllTools().some((t) => t.name === message.toolName) &&
				!pi.getActiveTools().includes(message.toolName)
			) {
				pi.setActiveTools([...pi.getActiveTools(), message.toolName])
			}
		} catch {
			// getAllTools/setActiveTools unavailable (bare harness) — guidance-only mode.
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
