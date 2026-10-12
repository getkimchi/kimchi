/**
 * Drops refused turns from the model context.
 *
 * When the gateway's guardrail (or the model itself) refuses a request — OpenAI
 * `finish_reason: content_filter`, Anthropic `stop_reason: refusal` — pi-ai turns
 * the reply into an `error` assistant message. Upstream's transform-messages
 * already skips errored assistant messages on replay, but keeps the user prompt
 * that triggered the refusal, so every later request re-sends it and gets
 * refused again ("hi" after a refused prompt is filtered too).
 *
 * The provider contract is that clients remove the refused turn from history.
 * This hook does that for the outgoing context only: everything from the user
 * message that opened the turn through the refusal is dropped. The session log
 * and transcript keep the turn so the user still sees what was refused.
 *
 * Registered in the shared extension list, so it covers both TUI and ACP.
 */

import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { classifyLLMGatewayError } from "../llm-gateway-error.js"
import { getRawErrorMessage } from "./error-preservation.js"

type AgentMessage = ContextEvent["messages"][number]

// pi-ai's Anthropic `refusal` fallback when the API sends no explanation.
const ANTHROPIC_REFUSAL_RE = /\bThe model refused to complete the request\b/

export function isRefusal(message: AgentMessage): boolean {
	if (message.role !== "assistant" || message.stopReason !== "error") return false
	const raw = getRawErrorMessage(message)
	if (!raw) return false
	return ANTHROPIC_REFUSAL_RE.test(raw) || classifyLLMGatewayError(raw)?.reason === "content_filter"
}

/** Return `messages` without refused turns, or the same array when there are none. */
export function pruneRefusedTurns(messages: AgentMessage[]): AgentMessage[] {
	const drop = new Set<number>()
	for (let i = 0; i < messages.length; i++) {
		if (!isRefusal(messages[i])) continue
		// Without the opening user message (e.g. compacted away) only the refusal goes.
		let start = i
		for (let j = i - 1; j >= 0 && !drop.has(j); j--) {
			if (messages[j].role === "user") {
				start = j
				break
			}
		}
		for (let j = start; j <= i; j++) drop.add(j)
	}
	if (drop.size === 0) return messages
	return messages.filter((_, i) => !drop.has(i))
}

export default function refusedTurnPruningExtension(pi: ExtensionAPI): void {
	pi.on("context", (event) => {
		const messages = pruneRefusedTurns(event.messages)
		if (messages === event.messages) return
		return { messages }
	})
}
