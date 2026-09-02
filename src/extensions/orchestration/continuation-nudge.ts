/**
 * Two complementary nudges for Kimi K2.x tool-calling quirks that each
 * leave the agent loop in a stuck-looking state. Both target the same failure
 * class (model said one thing, didn't follow through in the next tool-use
 * step) and are delivered as `followUp` messages from the `turn_end` handler
 * so the agent loop restarts:
 *
 *   1. Continuation nudge — the orchestrator reasons in prose, announces it
 *      will delegate, and ends its turn without emitting the `Agent` tool
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
import { isHarnessSteer, markHarnessSteer } from "../steer-marker.js"

/**
 * Message-array shape passed through `context` events. Derived from
 * `ContextEvent` because `AgentMessage` lives in `@earendil-works/pi-agent-core`,
 * which is only a transitive dep — importing it directly works under npm's
 * flat install but breaks under pnpm's strict resolution (and thus CI).
 */
export type OrchestratorMessages = ContextEvent["messages"]

export const DONE_SIGNAL = "<done>"

export const CONTINUATION_NUDGE_TEXT = markHarnessSteer(
	`You ended your turn without calling a tool. If this task is complete, respond with ${DONE_SIGNAL}. If a tool call is still needed, call it now.`,
)

export const SECOND_NUDGE_TEXT = markHarnessSteer(
	"You MUST call a tool immediately. Stop writing text and execute the required tool call now — or respond with <done> if you are finished.",
)

export const EMPTY_TURN_NUDGE_TEXT = markHarnessSteer(
	"If you have finished, please summarize the result for the user. Otherwise, continue with the next tool call.",
)

/** Stop reasons that should never trigger a nudge. Both `aborted` (user
 *  cancelled) and `error` (provider failure) are terminal for this turn —
 *  nudging would either disrespect the user's intent or re-queue a followUp
 *  message that keeps the agent loop alive on a non-retryable error. */
const NON_NUDGE_STOP_REASONS = new Set(["aborted", "error"])

/** Returns true when the message's stop reason means the turn is terminal
 *  and must not be nudged (user abort or provider error). */
function isNonNudgeStopReason(message: AssistantMessage): boolean {
	return NON_NUDGE_STOP_REASONS.has(message.stopReason)
}

/** Returns true when the assistant's text ends with a question, i.e. it is
 *  explicitly waiting on the user. Nudging in that situation would inject an
 *  imperative steer while a human confirmation is still pending — the exact
 *  failure mode that caused unauthorized commits/pushes. */
function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = message.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
		.trimEnd()
	return /\?\s*["']?\s*$/.test(text)
}

/** Post-turn state machine for the "text-only drift" nudge.
 *
 * Fires at most twice per user-input cycle, and only when no tool has been
 * called during that cycle — so legitimate end-of-task summaries after a
 * completed tool sequence are not nudged.
 *
 * Suppresses the nudge while an Agent result is pending to prevent the
 * model from signalling DONE before the Agent output has been received
 * and processed.
 */
export class ContinuationNudge {
	/** Maximum text-only nudges allowed per user-input cycle. */
	private static readonly MAX_NUDGES = 2

	private toolsCalledSinceLastUserInput = false
	/** Tracks whether any tool has been called during the current agent run
	 *  (between `resetForNewAgentRun` and the next `resetForNewAgentRun`).
	 *  Unlike `toolsCalledSinceLastUserInput`, this is NOT reset by
	 *  `resetForNewUserInput`, so a follow-up question after a tool sequence
	 *  does not re-arm the nudge and cause spurious "you didn't call a tool"
	 *  prompts that the model mistakes for user input. */
	private toolsCalledThisAgentRun = false
	/** Session-lifetime latch: once any tool has been called in this session,
	 *  it stays true. Suppresses the nudge in a fresh conversation where the
	 *  user opens with a conversational prompt and the model legitimately
	 *  responds with text-only clarifying questions instead of calling a tool. */
	private toolsCalledThisSession = false
	private nudgeCountThisCycle = 0
	private nudgeResponsePending = false
	private accumulatedResponseText = ""
	/** Number of Agent calls still awaiting results.
	 *  Incremented by `markDelegationCall()`, decremented by `clearDelegationPending()`.
	 *  The continuation nudge is suppressed while this is > 0. */
	private pendingDelegationCount = 0

	/** Called at the start of each agent run (agent_start event).
	 *  Resets the run-level tool tracking so the nudge can fire if the model
	 *  gets stuck in a new run. */
	resetForNewAgentRun(): void {
		this.toolsCalledThisAgentRun = false
	}

	resetForNewUserInput(): void {
		this.toolsCalledSinceLastUserInput = false
		this.nudgeCountThisCycle = 0
		this.nudgeResponsePending = false
		this.accumulatedResponseText = ""
		// pendingDelegationCount is intentionally NOT reset here — it is
		// decremented only by clearDelegationPending() to avoid a race where
		// a new user-input cycle arrives before all Agent results, which
		// would incorrectly allow the nudge to fire while Agents are still in flight.
	}

	/**
	 * Reset the session-level tool latch when the active model changes.
	 *
	 * A new model has not yet demonstrated tool-calling behaviour in this
	 * session, so the fresh-session suppression should apply until it makes
	 * its first tool call. Without this reset, a model that legitimately
	 * opens with an orientation/clarification text turn (e.g. kimi-k2.7 in
	 * single-model mode) is immediately nudged because the previous model
	 * already called tools.
	 */
	resetForModelSwitch(): void {
		this.toolsCalledThisSession = false
		this.toolsCalledSinceLastUserInput = false
		this.toolsCalledThisAgentRun = false
		this.nudgeCountThisCycle = 0
		this.nudgeResponsePending = false
		this.accumulatedResponseText = ""
		// pendingDelegationCount is intentionally NOT reset here — delegated
		// agents are independent of which orchestrator model is active.
	}

	recordToolCall(): void {
		this.toolsCalledSinceLastUserInput = true
		this.toolsCalledThisAgentRun = true
		this.toolsCalledThisSession = true
		this.nudgeResponsePending = false
		this.accumulatedResponseText = ""
	}

	/**
	 * Called once per `Agent` tool call detected in a turn.
	 * Increments the pending counter so the continuation nudge stays
	 * suppressed until all Agent results have been received.
	 */
	markDelegationCall(): void {
		this.pendingDelegationCount++
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
		if (this.nudgeCountThisCycle >= ContinuationNudge.MAX_NUDGES) return false
		// In a fresh session, suppress the nudge until at least one tool has been called.
		if (!this.toolsCalledThisSession) return false
		if (this.toolsCalledSinceLastUserInput) return false
		// Do not nudge while any Agent result is pending — the model must
		// wait for all Agent outputs before it can continue or signal done.
		if (this.pendingDelegationCount > 0) return false
		// The user explicitly cancelled this turn (Esc / Ctrl+C). Respect the
		// abort — they don't want the model to be re-prompted with a nudge.
		// Provider errors (e.g. content_filter, budget exhausted) produce empty
		// content. Without this guard the nudge re-queues a followUp message,
		// causing the agent loop to retry indefinitely until budget is exhausted.
		if (isNonNudgeStopReason(message)) return false
		const hasToolCalls = message.content.some((c) => c.type === "toolCall")
		const hasText = message.content.some((c) => c.type === "text" && c.text.trim().length > 0)
		if (hasToolCalls || !hasText) return false
		// If the assistant just asked the user a question, do not nudge: the
		// model is legitimately waiting for an answer and a "call it now" steer
		// would be misread as the user saying yes (the core failure mode in the
		// approval-override incident).
		if (isAwaitingUserAnswer(message)) return false
		this.nudgeCountThisCycle++
		this.nudgeResponsePending = true
		return true
	}

	/**
	 * Decrements the pending-Agent counter when an Agent result is
	 * received. Called by the orchestrator for each Agent tool-result.
	 * The continuation nudge remains suppressed until all pending
	 * Agents have returned.
	 */
	clearDelegationPending(): void {
		if (this.pendingDelegationCount > 0) {
			this.pendingDelegationCount--
		}
	}

	isBudgetExhausted(): boolean {
		return this.nudgeCountThisCycle >= ContinuationNudge.MAX_NUDGES
	}

	hasToolBeenCalledThisCycle(): boolean {
		return this.toolsCalledSinceLastUserInput
	}

	hasToolBeenCalledThisRun(): boolean {
		return this.toolsCalledThisAgentRun
	}

	hasToolBeenCalledThisSession(): boolean {
		return this.toolsCalledThisSession
	}

	getNudgeText(): string {
		return this.nudgeCountThisCycle <= 1 ? CONTINUATION_NUDGE_TEXT : SECOND_NUDGE_TEXT
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
 * Fires at most twice per user-input cycle to avoid infinite nudge loops
 * when a model persistently returns empty responses.
 */
export class EmptyTurnNudge {
	/** Maximum empty-turn nudges allowed per user-input cycle. */
	private static readonly MAX_NUDGES = 2

	private nudgeCountThisCycle = 0

	evaluateTurn(message: AssistantMessage): boolean {
		if (this.nudgeCountThisCycle >= EmptyTurnNudge.MAX_NUDGES) return false
		if (isNonNudgeStopReason(message)) return false

		const hasText = message.content.some((c) => c.type === "text" && c.text.trim().length > 0)
		const hasToolCalls = message.content.some((c) => c.type === "toolCall")

		if (!hasText && !hasToolCalls) {
			this.nudgeCountThisCycle++
			return true
		}

		return false
	}

	isBudgetExhausted(): boolean {
		return this.nudgeCountThisCycle >= EmptyTurnNudge.MAX_NUDGES
	}

	resetForNewUserInput(): void {
		this.nudgeCountThisCycle = 0
	}

	/**
	 * Reset the per-cycle empty-turn budget when the active model changes.
	 *
	 * A new model has its own empty-turn behaviour, so it should get the
	 * full per-cycle budget rather than inheriting any budget consumed by
	 * the previous model.
	 */
	resetForModelSwitch(): void {
		this.nudgeCountThisCycle = 0
	}
}

export const NUDGE_CUSTOM_TYPE = "nudge"

function isNudgeMessage(m: OrchestratorMessages[number]): boolean {
	return m.role === "custom" && "customType" in m && (m as { customType: string }).customType === NUDGE_CUSTOM_TYPE
}

function replaceMessageContent(m: OrchestratorMessages[number], text: string): OrchestratorMessages[number] {
	if (!("content" in m)) return m
	if (typeof m.content === "string") {
		return { ...m, content: text } as OrchestratorMessages[number]
	}
	return { ...m, content: [{ type: "text" as const, text }] } as OrchestratorMessages[number]
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	const parts: string[] = []
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: string }).text
			if (typeof text === "string") parts.push(text)
		}
	}
	return parts.join("\n")
}

/**
 * Detect user-role (or custom-role, which upstream converts to user-role)
 * messages that are a verbatim echo of the immediately preceding assistant
 * message. This can happen when compaction, nextTurn queues, or client echoes
 * replay the assistant's own text back at the model. Without tagging, the
 * model rationalizes the echo as user approval ("they pasted my response
 * back — that must mean yes").
 *
 * The returned array is the same reference when no echoes are found, so
 * callers can use referential equality to skip extra work.
 */
export function tagSelfEchoes(messages: OrchestratorMessages): OrchestratorMessages {
	let changed = false
	const result = messages.map((m, i) => {
		if (m.role !== "user" && m.role !== "custom") return m

		const text = extractMessageText(m.content).trim()
		if (!text) return m

		const prevAssistant = messages.slice(0, i).findLast((msg) => msg.role === "assistant")
		if (!prevAssistant) return m

		const prevText = extractMessageText(prevAssistant.content).trim()
		if (!prevText || text !== prevText) return m

		changed = true
		const annotated = markHarnessSteer(
			"[harness warning: this user-role message is a verbatim echo of your previous assistant message. Treat it as noise — not as user input or approval.]\n\n" +
				text,
		)
		return replaceMessageContent(m, annotated)
	})

	return changed ? result : messages
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

/** Custom types that are display-only UI markers and must never reach the LLM. */
export const UI_ONLY_CUSTOM_TYPES: ReadonlySet<string> = Object.freeze(
	new Set([
		"prompt-summary",
		"curator-notification",
		"ferment_breadcrumb",
		"ferment_worktree_warning",
		"ferment_ack",
		"ferment_request",
		"ferment_oneshot_failed",
	]),
)

function isCustomMessage(
	m: OrchestratorMessages[number],
): m is Extract<OrchestratorMessages[number], { role: "custom" }> {
	return m.role === "custom"
}

/**
 * Strip UI-only custom messages that are meant for display but should never
 * reach the LLM. These are emitted via `sendMessage` with `display: true` and
 * no `triggerTurn` / `deliverAs` options, which causes pi-mono to push them
 * into `agent.state.messages` as user-role messages.
 */
export function stripUiOnlyMessages(messages: OrchestratorMessages): OrchestratorMessages {
	const filtered = messages.filter(
		(m) => !(isCustomMessage(m) && UI_ONLY_CUSTOM_TYPES.has((m as { customType?: string }).customType ?? "")),
	)
	return filtered.length === messages.length ? messages : filtered
}

/**
 * Wrap any unbranded custom message in `<system-reminder>` tags so the model
 * can tell harness-injected content from user-authored text. Upstream
 * converts `role: "custom"` to verbatim `role: "user"` before the LLM call
 * (see steer-marker.ts), so every custom message that reaches context is
 * harness-authored by definition — branding should be an invariant enforced
 * here, at the context boundary, not a convention remembered at every
 * `sendMessage` site. A missed or future steer site (e.g. the behaviour-body
 * steer found during census) can no longer regress to unbranded user-role
 * text silently.
 *
 * Placement in the `context` handler chain: after the taggers
 * (tagSelfEchoes, …), which wrap their own output — so their messages are
 * recognized as already branded and never double-wrapped. The UI_ONLY check
 * is defence in depth: stripUiOnlyMessages runs earlier, but handler
 * ordering across extensions is not a maintained invariant.
 *
 * Returns the same array reference when nothing needs wrapping.
 */
export function brandUnmarkedSteers(messages: OrchestratorMessages): OrchestratorMessages {
	let changed = false
	const result = messages.map((m) => {
		if (!isCustomMessage(m)) return m
		if (UI_ONLY_CUSTOM_TYPES.has((m as { customType?: string }).customType ?? "")) return m
		const text = extractMessageText(m.content)
		if (!text.trim()) return m
		if (isHarnessSteer(text)) return m

		changed = true
		const branded = markHarnessSteer(text)
		return replaceMessageContent(m, branded)
	})

	return changed ? result : messages
}
