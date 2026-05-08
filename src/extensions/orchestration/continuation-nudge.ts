/**
 * Two complementary nudges for Kimi K2.x tool-calling quirks that each
 * leave the agent loop in a stuck-looking state. Both target the same failure
 * class (model said one thing, didn't follow through in the next tool-use
 * step) and are delivered as `followUp` messages from the `turn_end` handler
 * so the agent loop restarts:
 *
 *   1. Continuation nudge — the orchestrator reasons in prose, announces it
 *      will delegate, and ends its turn without emitting the `subagent` tool
 *      call. Mirrors AISI Inspect's `on_continue`.
 *
 *   2. Empty-turn nudge — some Kimi deployments return an empty response
 *      (no text, no tool calls) after receiving tool results from a
 *      tool-call-only turn. `EmptyTurnNudge` tracks whether the previous
 *      turn was tool-call-only so the `turn_end` handler can decide.
 *
 * Both are delivered as custom messages with `display: false` so they
 * never appear in the conversation. Stale nudges (those the model has
 * already acted on) are stripped from the LLM context by
 * `stripStaleNudges` before each call.
 *
 * Both are orchestrator-only concerns — wired in `prompt-enrichment.ts`
 * inside the `if (!subagentMode)` guard.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { ContextEvent } from "@earendil-works/pi-coding-agent"

/**
 * Message-array shape passed through `context` events. Derived from
 * `ContextEvent` because `AgentMessage` lives in `@earendil-works/pi-agent-core`,
 * which is only a transitive dep — importing it directly works under npm's
 * flat install but breaks under pnpm's strict resolution (and thus CI).
 */
export type OrchestratorMessages = ContextEvent["messages"]

export const DONE_SIGNAL = "<done>"

export const CONTINUATION_NUDGE_TEXT = `You ended your turn without calling a tool. If this task is complete, respond with ${DONE_SIGNAL}. If a tool call is still needed, call it now.`

export const EMPTY_TURN_NUDGE_TEXT =
	"If you have finished, please summarize the result for the user. Otherwise, continue with the next tool call."

/**
 * Post-turn state machine for the "text-only drift" nudge.
 *
 * Fires at most once per user-input cycle, and only when no tool has been
 * called during that cycle — so legitimate end-of-task summaries after a
 * completed tool sequence are not nudged.
 *
 * Suppresses the nudge while a subagent result is pending to prevent the
 * model from signalling DONE before the subagent output has been received
 * and processed.
 */
export class ContinuationNudge {
	private toolsCalledSinceLastUserInput = false
	private nudgedSinceLastUserInput = false
	private nudgeResponsePending = false
	private accumulatedResponseText = ""
	/** Number of subagent calls still awaiting results.
	 *  Incremented by `markSubagentCall()`, decremented by `clearSubagentPending()`.
	 *  The continuation nudge is suppressed while this is > 0. */
	private pendingSubagentCount = 0

	resetForNewUserInput(): void {
		this.toolsCalledSinceLastUserInput = false
		this.nudgedSinceLastUserInput = false
		this.nudgeResponsePending = false
		this.accumulatedResponseText = ""
		// pendingSubagentCount is intentionally NOT reset here — it is
		// decremented only by clearSubagentPending() to avoid a race where
		// a new user-input cycle arrives before all subagent results, which
		// would incorrectly allow the nudge to fire while subagents are
		// still in flight.
	}

	recordToolCall(): void {
		this.toolsCalledSinceLastUserInput = true
		this.nudgeResponsePending = false
		this.accumulatedResponseText = ""
	}

	/**
	 * Called once per `subagent` tool call detected in a turn.
	 * Increments the pending counter so the continuation nudge stays
	 * suppressed until all subagent results have been received.
	 */
	markSubagentCall(): void {
		this.pendingSubagentCount++
	}

	isNudgeResponsePending(): boolean {
		return this.nudgeResponsePending
	}

	accumulateResponse(text: string): void {
		this.accumulatedResponseText += text
	}

	isDoneSignalReceived(): boolean {
		return this.accumulatedResponseText.trim() === DONE_SIGNAL
	}

	evaluateTurn(message: AssistantMessage): boolean {
		if (this.nudgedSinceLastUserInput) return false
		if (this.toolsCalledSinceLastUserInput) return false
		// Do not nudge while any subagent result is pending — the model must
		// wait for all subagent outputs before it can continue or signal done.
		if (this.pendingSubagentCount > 0) return false
		const hasToolCalls = message.content.some((c) => c.type === "toolCall")
		const hasText = message.content.some((c) => c.type === "text" && c.text.trim().length > 0)
		if (hasToolCalls || !hasText) return false
		this.nudgedSinceLastUserInput = true
		this.nudgeResponsePending = true
		return true
	}

	/**
	 * Decrements the pending-subagent counter when a subagent result is
	 * received. Called by the orchestrator for each subagent tool-result.
	 * The continuation nudge remains suppressed until all pending
	 * subagents have returned.
	 */
	clearSubagentPending(): void {
		if (this.pendingSubagentCount > 0) {
			this.pendingSubagentCount--
		}
	}
}

/**
 * Nudges the model when it returns a completely empty response (no text,
 * no tool calls). Some model deployments occasionally return empty
 * responses — either after receiving tool results from a tool-call-only
 * turn, or as the very first response to a user prompt. Without the
 * nudge the agent loop stalls because there is nothing to execute or
 * display.
 *
 * Fires at most once per user-input cycle to avoid infinite nudge loops
 * when a model persistently returns empty responses.
 */
export class EmptyTurnNudge {
	private nudgedSinceLastUserInput = false

	evaluateTurn(message: AssistantMessage): boolean {
		if (this.nudgedSinceLastUserInput) return false

		const hasText = message.content.some((c) => c.type === "text" && c.text.trim().length > 0)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall")

		if (!hasText && !hasToolCalls) {
			this.nudgedSinceLastUserInput = true
			return true
		}

		return false
	}

	resetForNewUserInput(): void {
		this.nudgedSinceLastUserInput = false
	}
}

export const NUDGE_CUSTOM_TYPE = "nudge"

function isNudgeMessage(m: OrchestratorMessages[number]): boolean {
	return m.role === "custom" && "customType" in m && (m as { customType: string }).customType === NUDGE_CUSTOM_TYPE
}

/**
 * Strip nudge messages that the model has already acted on (i.e. there is an
 * assistant response after them). Keeps nudges that are still at the tail of
 * the array — the model hasn't seen those yet.
 */
export function stripStaleNudges(messages: OrchestratorMessages): OrchestratorMessages {
	const lastAssistantIdx = messages.findLastIndex((m) => m.role === "assistant")
	if (lastAssistantIdx === -1) return messages
	const stripped = messages.filter((m, i) => i > lastAssistantIdx || !isNudgeMessage(m))
	return stripped.length === messages.length ? messages : stripped
}
