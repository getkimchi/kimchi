import type { OrchestratorMessages } from "../orchestration/continuation-nudge.js"

/** Minimal shape of the active model needed for the cross-model check.
 *  Structurally compatible with pi-ai's `Model` (provider/api/id). */
export interface ActiveModelRef {
	provider: string
	api: string
	id: string
}

/**
 * Remove `thinking` content blocks from assistant messages produced by a
 * different model than the currently active one.
 *
 * Why: after a user switches models mid-session, pi-ai's `transformMessages`
 * converts the previous model's `thinking` blocks into plain assistant TEXT
 * so the (cross-model) provider request stays valid. To the new model that
 * converted text looks like assistant-authored chain-of-thought — an
 * in-context example of "emit reasoning prose, then stop".
 *
 * Evidence (2026-08-19): a session in which the user switched glm-5.2-fp8 →
 * kimi-k2.7 stalled for four consecutive turns (reasoning prose or
 * reasoning-only, stop=stop, zero tool calls). Replaying the reconstructed
 * 141-message context against kimi-k2.7 via the gateway reproduced the stall;
 * replaying the same context with cross-model thinking blocks stripped made
 * kimi-k2.7 call a tool immediately. Controls (glm-5.2-fp8, kimi-k3) called
 * tools on the full context. See .kimchi/docs/plan-cross-model-thinking-strip.md.
 *
 * Same-model semantics mirror pi-ai's `isSameModel` in
 * `transformMessages`: all three identifiers (provider, api, model id)
 * must match for a block to be kept. Same-model thinking is preserved
 * verbatim — signed/redacted thinking replay depends on it.
 *
 * Content-less edge: an assistant message that contained ONLY thinking
 * blocks keeps its slot with an empty `content` array. pi-ai's
 * `convertMessages` deterministically skips such messages ("Skip assistant
 * messages that have no content and no tool calls") and synthesises results
 * for orphaned tool calls, so no placeholder is needed here.
 *
 * Placement note: this transform is wired into the `context` handlers in
 * `prompt-enrichment.ts`. `emitContext` composes handlers in extension
 * registration order, and no context handler registered after
 * prompt-enrichment (hide-thinking, tool-rendering, todos, ferment)
 * creates `thinking` blocks — hide-thinking only rewrites `<think>`-tag
 * TEXT for display restore — so the strip cannot be re-undone downstream.
 */
export function stripCrossModelThinking(
	messages: OrchestratorMessages,
	model: ActiveModelRef | undefined,
): OrchestratorMessages {
	// No active model (edge of session lifecycle): cannot compare provenance,
	// leave messages untouched.
	if (!model) return messages
	let changed = false
	const stripped = messages.map((msg) => {
		if (msg.role !== "assistant") return msg
		const isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id
		if (isSameModel) return msg
		if (!msg.content.some((block) => block.type === "thinking")) return msg
		changed = true
		return { ...msg, content: msg.content.filter((block) => block.type !== "thinking") }
	})
	return changed ? stripped : messages
}
