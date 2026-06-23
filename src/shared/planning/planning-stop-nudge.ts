/**
 * Planning stop-nudge logic.
 *
 * Used by plan mode (permissions extension): the model made tool calls, then
 * ended with stopReason "stop" without writing PLAN_COMPLETE. Without a nudge
 * the session stalls silently.
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
 * Returns true if the turn text contains a known plan-mode completion signal.
 */
export function hasPlanCompletionSignal(text: string): boolean {
	return text.includes("<!-- PLAN_COMPLETE -->") || text.includes("<done>")
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
 */
export function contentHasToolCall(content: unknown[]): boolean {
	return content.some((c) => (c as { type: string }).type === "tool_use")
}
