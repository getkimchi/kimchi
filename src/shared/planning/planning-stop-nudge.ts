/**
 * Planning stop-nudge logic.
 *
 * Used by:
 * - Plan mode (permissions extension): the model made tool calls, then ended
 *   with stopReason "stop" without writing PLAN_COMPLETE.
 * - Ferment scoping (ferment extension): the model made tool calls during
 *   draft scoping, then ended with stopReason "stop" without calling
 *   scope_ferment or propose_ferment_scoping.
 *
 * Without a nudge the session stalls silently.
 *
 * Note: ferment worker sessions do NOT need this nudge — a worker stopping
 * with stopReason "stop" means it finished its assigned task normally.
 *
 * This module is pi-agnostic: it exports the decision logic and message text.
 * The caller owns the pi.sendMessage wiring.
 */

export const MAX_PLANNING_STOP_NUDGES = 2

/**
 * Whether a turn qualifies for a stop nudge.
 *
 * Returns true when:
 * - The turn had at least one tool call (pure text turns are a different stall)
 * - stopReason is "stop" (model chose to end, not end_turn / tool_use)
 * - The completion signal is absent from the turn text
 */
export function shouldNudge(opts: {
	hasToolCall: boolean
	stopReason: string | undefined
	completionSignalPresent: boolean
}): boolean {
	if (!opts.hasToolCall) return false
	if (opts.stopReason !== "stop") return false
	if (opts.completionSignalPresent) return false
	return true
}

/**
 * Returns true if the nudge count has hit the cap and the nudge should be
 * suppressed to avoid flooding the context.
 */
export function isNudgeSuppressed(count: number): boolean {
	return count > MAX_PLANNING_STOP_NUDGES
}

/**
 * Nudge text for plan mode (interactive, non-worker session).
 * Instructs the model to finish writing the plan and emit PLAN_COMPLETE.
 */
export const PLAN_MODE_STOP_NUDGE =
	"You stopped without completing the plan. Continue now:\n" +
	"- If you still have open questions, use the questionnaire tool to resolve them.\n" +
	"- If the plan is ready, write it out in full using the Goal / Constraints / Chunks / Verification Strategy / Decision Log / Risks structure, then end your response with <!-- PLAN_COMPLETE --> on its own line.\n" +
	"- Do NOT stop again until you have written <!-- PLAN_COMPLETE -->."

/**
 * Nudge text for interactive ferment scoping. Instructs the model to continue
 * toward calling propose_ferment_scoping.
 */
export const FERMENT_SCOPING_STOP_NUDGE_INTERACTIVE =
	"You stopped during ferment scoping without finalising the plan. Continue now:\n" +
	"- If you still need more orientation or exploration, take the next concrete tool call to gather it.\n" +
	"- If you have enough context to plan, call `propose_ferment_scoping` with the complete payload: goal, success_criteria, constraints, assumptions, phases, and the P1/P2/P3 gates array.\n" +
	"- Do NOT stop again until you have called the scoping tool or made progress toward it."

/**
 * Nudge text for one-shot ferment scoping. Instructs the model to continue
 * toward calling scope_ferment directly (no interactive tools available).
 */
export const FERMENT_SCOPING_STOP_NUDGE_ONESHOT =
	"You stopped during ferment scoping without finalising the plan. Continue now:\n" +
	"- If you still need information, call `ask_user` — questions route automatically to the judge.\n" +
	"- If you have enough context to plan, call `scope_ferment` with the complete payload: goal, success_criteria, constraints, assumptions, phases, and the P1/P2/P3 gates array.\n" +
	"- Do NOT stop again until you have called scope_ferment or made progress toward it."

/**
 * @deprecated Use FERMENT_SCOPING_STOP_NUDGE_INTERACTIVE or FERMENT_SCOPING_STOP_NUDGE_ONESHOT.
 * Kept for backwards compatibility with callers that don't know their mode yet.
 */
export const FERMENT_SCOPING_STOP_NUDGE = FERMENT_SCOPING_STOP_NUDGE_INTERACTIVE

/**
 * Returns true if the turn text contains a known plan-mode completion signal.
 */
export function hasPlanCompletionSignal(text: string): boolean {
	return text.includes("<!-- PLAN_COMPLETE -->") || text.includes("<done>")
}

/**
 * Tool names whose presence in a turn signals ferment scoping progress.
 * A turn that calls one of these is considered a completion signal for the
 * scoping stop-nudge (no nudge needed).
 */
const FERMENT_SCOPING_COMPLETION_TOOLS = new Set([
	"scope_ferment",
	"propose_ferment_scoping",
	"confirm_ferment_completion_criteria",
])

/**
 * Returns true if any tool call in the turn signals ferment scoping progress.
 */
export function hasFermentScopingCompletionSignal(toolNames: string[]): boolean {
	return toolNames.some((name) => FERMENT_SCOPING_COMPLETION_TOOLS.has(name))
}

/**
 * Extracts plain text from an assistant message content array.
 * Works with both pi-mono content shapes.
 */
export function extractTextFromContent(content: unknown[]): string {
	return content
		.filter((c) => (c as { type: string }).type === "text")
		.map((c) => (c as { type: "text"; text: string }).text)
		.join("\n")
}

/**
 * Returns true if the content array contains at least one tool call.
 *
 * Checks both:
 * - `"toolCall"` — the pi-mono normalized shape used in `turn_end` assistant messages.
 * - `"tool_use"` — the raw provider shape (Anthropic), kept for defensive compatibility.
 */
export function contentHasToolCall(content: unknown[]): boolean {
	return content.some((c) => {
		const type = (c as { type: string }).type
		return type === "toolCall" || type === "tool_use"
	})
}
