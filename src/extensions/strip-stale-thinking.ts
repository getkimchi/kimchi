/**
 * Strips native `thinking` content blocks from assistant messages that precede
 * the latest user turn, keeping the current turn's thinking intact.
 *
 * Why this is safe:
 * - Anthropic requires thinking blocks to be preserved *within the turn where a
 *   tool call was made* (extended thinking + tool use). It does NOT require
 *   thinking from earlier turns — those may be dropped freely. The latest user
 *   message is exactly that boundary: everything at/after it belongs to the
 *   in-progress turn (assistant → toolResult → assistant → …) and is left
 *   untouched; everything before it is a prior turn and safe to strip.
 * - Only `thinking` blocks are removed. Tool calls and text are retained, so no
 *   tool_use/tool_result pairing is ever broken.
 * - Redacted thinking is modeled as a `thinking` block with `redacted: true`
 *   (opaque, model-scoped payload). Dropping it from prior turns is likewise
 *   safe and intentional — it only needs to survive within its own turn.
 *
 * Value: for same-model multi-turn sessions, pi-ai otherwise sends prior-turn
 * thinking blocks back with their signatures. Stripping them trims stale
 * reasoning from the context window.
 *
 * Empty-message handling: if stripping would leave an assistant message with no
 * content, we keep it unchanged rather than drop it. Dropping could leave two
 * consecutive user turns (nothing downstream coalesces same-role messages),
 * and a completed assistant turn with only thinking is degenerate anyway
 * (aborted turns are already dropped upstream by transformMessages).
 */

import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"

type ContextMessages = ContextEvent["messages"]

export function findLatestUserMessageIndex(messages: ContextMessages): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i
	}
	return -1
}

export function stripStaleThinkingBeforeLatestUser(messages: ContextMessages): ContextMessages {
	const latestUserIndex = findLatestUserMessageIndex(messages)
	if (latestUserIndex <= 0) return messages

	let changed = false
	const stripped: ContextMessages = []

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (i >= latestUserIndex || message.role !== "assistant") {
			stripped.push(message)
			continue
		}

		const content = message.content.filter((block) => block.type !== "thinking")
		// No thinking blocks, or stripping would empty the message — keep as-is.
		if (content.length === message.content.length || content.length === 0) {
			stripped.push(message)
			continue
		}

		changed = true
		stripped.push({ ...message, content })
	}

	return changed ? stripped : messages
}

export default function stripStaleThinkingExtension(pi: ExtensionAPI): void {
	pi.on("context", async (event) => {
		const messages = stripStaleThinkingBeforeLatestUser(event.messages)
		if (messages !== event.messages) return { messages }
	})
}
