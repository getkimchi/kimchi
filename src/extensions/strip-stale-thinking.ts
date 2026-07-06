/**
 * Strips stale reasoning from assistant messages older than the last two user
 * turns, keeping the previous and current turns' reasoning intact.
 *
 * Two reasoning representations exist and both are stripped:
 * - Native `thinking` content blocks (`type: "thinking"`). Anthropic-shaped, and
 *   also what the openai-completions provider builds when the LiteLLM gateway
 *   returns reasoning in a `reasoning_content` / `reasoning` / `reasoning_text`
 *   field.
 * - Inline reasoning tags (`<think>…</think>`, `<mm:think>…</mm:think>`,
 *   `<thinking>…</thinking>`) embedded in a `text` block. This is how models
 *   whose gateway does NOT split reasoning into a separate field surface it
 *   (e.g. MiniMax emits `<mm:think>`). `hide-thinking` only transforms these for
 *   display and restores the originals into context at `context` time — so
 *   without this pass they would otherwise persist across turns untouched.
 *
 * Why this is safe:
 * - Reasoning only needs to be preserved for the current tool-use turn and a
 *   short recency window. The second-latest user message is that boundary:
 *   everything at/after it belongs to the last two turns and is left untouched;
 *   everything before it is older context and safe to strip.
 * - For open-weights models routed through the gateway there is no cryptographic
 *   thinking signature to invalidate — the `thinkingSignature` is cosmetic — so
 *   dropping prior-turn reasoning cannot produce a signature/ordering error.
 * - Tool calls are never touched, so no tool_use/tool_result pairing is broken.
 * - Redacted thinking is modeled as a `thinking` block with `redacted: true`
 *   (opaque, model-scoped payload). Dropping it from prior turns is likewise
 *   safe and intentional — it only needs to survive within its own turn.
 *
 * Ordering: this runs after `hide-thinking` (registered earlier in cli.ts), so it
 * sees the restored original inline tags rather than the display-transformed text.
 *
 * Empty-message handling: if stripping would leave an assistant message with no
 * content, we keep it unchanged rather than drop it. Dropping could leave two
 * consecutive user turns (nothing downstream coalesces same-role messages), and a
 * completed assistant turn with only reasoning is degenerate anyway (aborted
 * turns are already dropped upstream by transformMessages).
 */

import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"

type ContextMessages = ContextEvent["messages"]
type AssistantContent = Extract<ContextMessages[number], { role: "assistant" }>["content"]
type ContentBlock = AssistantContent[number]

const RETAINED_REASONING_USER_TURNS = 2

// Closed reasoning spans emitted inline in text by models whose gateway does not
// split reasoning into a dedicated field. Kept in sync with the tag set handled
// by hide-thinking.ts / permissions/classifier.ts. Unclosed spans are left alone
// (a completed prior turn is expected to be balanced).
const INLINE_REASONING_PATTERN =
	/<think>[\s\S]*?<\/think>|<thinking>[\s\S]*?<\/thinking>|<mm:think>[\s\S]*?<\/mm:think>/g

function stripInlineReasoning(text: string): string {
	return text.replace(INLINE_REASONING_PATTERN, "")
}

export function findLatestUserMessageIndex(messages: ContextMessages): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i
	}
	return -1
}

export function findRetainedUserTurnStartIndex(
	messages: ContextMessages,
	retainedUserTurns = RETAINED_REASONING_USER_TURNS,
): number {
	if (retainedUserTurns <= 0) return messages.length

	let seenUserTurns = 0
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "user") continue
		seenUserTurns++
		if (seenUserTurns === retainedUserTurns) return i
	}
	return -1
}

/**
 * Removes native thinking blocks and inline reasoning tags from one assistant
 * message's content. Returns the original content reference when nothing changed
 * so callers can preserve message identity and the empty-message guard applies.
 */
function stripReasoningFromContent(content: AssistantContent): AssistantContent {
	let changed = false
	const rebuilt: ContentBlock[] = []

	for (const block of content) {
		if (block.type === "thinking") {
			changed = true
			continue
		}

		if (block.type === "text") {
			const cleaned = stripInlineReasoning(block.text)
			if (cleaned !== block.text) {
				changed = true
				// Text block that was pure reasoning — drop it entirely.
				if (cleaned.trim().length === 0) continue
				rebuilt.push({ ...block, text: cleaned })
				continue
			}
		}

		rebuilt.push(block)
	}

	return changed ? rebuilt : content
}

export function stripStaleThinkingBeforeLastUserTurns(messages: ContextMessages): ContextMessages {
	const retentionStartIndex = findRetainedUserTurnStartIndex(messages)
	if (retentionStartIndex <= 0) return messages

	let changed = false
	const stripped: ContextMessages = []

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (i >= retentionStartIndex || message.role !== "assistant") {
			stripped.push(message)
			continue
		}

		const content = stripReasoningFromContent(message.content)
		// Nothing removed, or stripping would empty the message — keep as-is.
		if (content === message.content || content.length === 0) {
			stripped.push(message)
			continue
		}

		changed = true
		stripped.push({ ...message, content })
	}

	return changed ? stripped : messages
}

export function stripStaleThinkingBeforeLatestUser(messages: ContextMessages): ContextMessages {
	return stripStaleThinkingBeforeLastUserTurns(messages)
}

export default function stripStaleThinkingExtension(pi: ExtensionAPI): void {
	pi.on("context", async (event) => {
		const messages = stripStaleThinkingBeforeLastUserTurns(event.messages)
		if (messages !== event.messages) return { messages }
	})
}
