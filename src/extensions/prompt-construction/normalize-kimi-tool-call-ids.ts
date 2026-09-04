/**
 * kimi-k2.x historical tool_call ID normalization.
 *
 * Moonshot trains the K2 family with tool-call IDs in the canonical format
 * `functions.{tool_name}:{idx}` (see Kimi-K2 docs/tool_call_guidance.md), and
 * k2.x deployments abandon turns (immediate end-of-turn with no content) when
 * conversation history carries non-canonical IDs, e.g. OpenAI-style `call_*`
 * IDs written by another model during a mid-session model switch.
 * Corroborated upstream: MoonshotAI/Kimi-K2#128, vllm-project/vllm#50782.
 * Measured for kimchi (getkimchi/kimchi#1063): on a reconstructed 141-message
 * / ~75k-token context, kimi-k2.7 acted in only 1/10 trials on canonical
 * mismatch and 12/12 after rewriting IDs to the canonical format.
 *
 * Moonshot's hosted gateway rewrites IDs server-side; LiteLLM (the ai-enabler
 * gateway our provider routes through) does not. Until it does, we rewrite
 * here for kimi-k2.* targets.
 *
 * Every assistant toolCall ID is rewritten to `functions.{name}:{idx}` with a
 * global incrementing index, and each `toolResult.toolCallId` is remapped with
 * the same value so call/result pairing stays intact. Already-canonical IDs
 * are renumbered as well: keeping them while rewriting the rest could yield
 * duplicate IDs (e.g. a historical `functions.bash:0` colliding with an
 * assigned `functions.bash:0`), and a single globally consistent sequence
 * matches the training distribution.
 *
 * Copy-on-write: messages that need no rewriting are returned by reference; if
 * the context contains no tool calls at all, the original array is returned.
 */

import type { ContextEvent } from "@earendil-works/pi-coding-agent"

type ContextMessages = ContextEvent["messages"]

const KIMI_K2_ID = /kimi-k2(?:[.-]|$)/i

/** True for kimi-k2.x model ids (kimi-k2.5/2.6/2.7, kimi-k2-thinking, ...). */
export function isKimiK2Model(modelId: string | undefined): boolean {
	return !!modelId && KIMI_K2_ID.test(modelId)
}

type ToolCallBlockLite = { type?: string; id?: unknown; name?: unknown }
type MessageLite = { role?: string; content?: unknown; toolCallId?: unknown }

export function normalizeKimiToolCallIds(messages: ContextMessages): ContextMessages {
	// Pass 1: assign a canonical ID to every assistant toolCall block, in
	// context order.
	const renames = new Map<string, string>()
	let nextIdx = 0
	for (const msg of messages) {
		const lite = msg as MessageLite
		if (lite.role !== "assistant" || !Array.isArray(lite.content)) continue
		for (const block of lite.content as ToolCallBlockLite[]) {
			if (block?.type !== "toolCall" || typeof block.id !== "string" || block.id.length === 0) continue
			const name = typeof block.name === "string" && block.name.length > 0 ? block.name : "tool"
			renames.set(block.id, `functions.${name}:${nextIdx++}`)
		}
	}
	if (renames.size === 0) return messages

	// Pass 2: rewrite assistant toolCall IDs and the paired toolResult
	// toolCallIds with the same mapping.
	return messages.map((msg) => {
		const lite = msg as MessageLite
		if (lite.role === "assistant" && Array.isArray(lite.content)) {
			let changed = false
			const content = (lite.content as ToolCallBlockLite[]).map((block) => {
				if (block?.type === "toolCall" && typeof block.id === "string") {
					const renamed = renames.get(block.id)
					if (renamed && renamed !== block.id) {
						changed = true
						return { ...block, id: renamed }
					}
				}
				return block
			})
			return changed ? ({ ...(msg as object), content } as ContextMessages[number]) : msg
		}
		if (lite.role === "toolResult" && typeof lite.toolCallId === "string") {
			const renamed = renames.get(lite.toolCallId)
			if (renamed && renamed !== lite.toolCallId) {
				return { ...(msg as object), toolCallId: renamed } as ContextMessages[number]
			}
		}
		return msg
	})
}
