// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
/**
 * Handles refused turns: detects them from the provider's response fields,
 * tells the user why, and keeps them out of the model context.
 *
 * The gateway guardrail refuses in-band (HTTP 200), the same way a provider's
 * own safety filter does, so a refusal is read from the raw stream events
 * before pi-ai flattens them into a generic `error` stop reason:
 * - OpenAI chat completions: `choices[].finish_reason: "content_filter"`
 * - OpenAI responses: `response.refusal.done`, or `incomplete_details.reason: "content_filter"`
 * - Anthropic messages: `message_delta` with `delta.stop_reason: "refusal"`
 *
 * On `message_end` the refused assistant message is replaced: the canned
 * refusal text is dropped and `errorMessage` becomes REFUSAL_MESSAGE, which is
 * what the user sees and what the session log keeps. ACP chunks are append-only,
 * so text streamed before the refusal event stays visible there, followed by
 * REFUSAL_MESSAGE.
 *
 * The provider contract is that clients remove the refused turn from history,
 * otherwise every later request re-sends the prompt and is refused again.
 * The `context` hook drops everything from the user message that opened the
 * turn through the refusal, for the outgoing context only. REFUSAL_MESSAGE is
 * the persisted marker, so resumed sessions are pruned too.
 *
 * Registered in the shared extension list, so it covers both TUI and ACP.
 */

import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"

type AgentMessage = ContextEvent["messages"][number]

export const REFUSAL_MESSAGE =
	"This request was declined under the usage policy and removed from the conversation. Rephrase it to continue."

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

/** True when a raw provider stream event reports that the request was refused. */
export function isRefusalStreamEvent(data: unknown): boolean {
	if (!isRecord(data)) return false
	if (Array.isArray(data.choices)) {
		return data.choices.some((choice) => isRecord(choice) && choice.finish_reason === "content_filter")
	}
	if (data.type === "message_delta") return isRecord(data.delta) && data.delta.stop_reason === "refusal"
	if (data.type === "response.refusal.done") return true
	const response = data.response
	return (
		isRecord(response) &&
		isRecord(response.incomplete_details) &&
		response.incomplete_details.reason === "content_filter"
	)
}

export function isRefusal(message: AgentMessage): boolean {
	return message.role === "assistant" && message.stopReason === "error" && message.errorMessage === REFUSAL_MESSAGE
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

export default function refusedTurnsExtension(pi: ExtensionAPI): void {
	let refused = false

	pi.on("before_provider_request", () => {
		refused = false
	})

	pi.on("provider_stream_event", (event) => {
		if (isRefusalStreamEvent(event.data)) refused = true
	})

	pi.on("message_end", (event) => {
		if (!refused || event.message.role !== "assistant") return
		refused = false
		return { message: { ...event.message, content: [], stopReason: "error", errorMessage: REFUSAL_MESSAGE } }
	})

	pi.on("context", (event) => {
		const messages = pruneRefusedTurns(event.messages)
		if (messages === event.messages) return
		return { messages }
	})
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
