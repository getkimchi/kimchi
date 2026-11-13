/**
 * Two complementary nudges for Kimi K2.x tool-calling quirks that each
 * leave the agent loop in a stuck-looking state. Both target the same failure
 * class (model said one thing, didn't follow through in the next tool-use
 * step) and are delivered as `followUp` messages from the `turn_end` handler
 * so the agent loop restarts:
 *
 *   1. Continuation nudge — the orchestrator reasons in prose, announces it
 *      will delegate, and ends its turn without emitting the `Agent` tool
 *      call. Mirrors AISI Inspect's `on_continue`. A broken-announcement
 *      carve-out (`looksLikeBrokenAnnouncement`) also fires this nudge on
 *      announcement-shaped text-only stops *after* tools ran in the cycle
 *      — the kimi-k3 quirk where the model announces a write and never
 *      emits it.
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
 * The `DONE_SIGNAL` ("<done>") sent in response to a continuation nudge is
 * an **end-of-turn** signal, never a claim that the task is complete — it is
 * a silent acknowledgement of the hidden nudge that also covers waiting on
 * the user (a blocking question, or the user said stop/wait). The nudge copy
 * requests the token alone so the normal exit from a recovery turn is the
 * bare token; it should not produce an unexplained second answer after the
 * assistant's original response. Detection stays an exact match
 * (`trim() === DONE_SIGNAL`); responses with extra prose still rely on the
 * existing `stopReason === "stop"` escape in the turn_end handler. As
 * defence in depth, a bare token is never re-nudged even when pending
 * bookkeeping was lost: `evaluateTurn` suppresses it directly, and the
 * prompt-enrichment `message_end` handler blanks a non-pending bare token
 * from the stored message and marks it withheld.
 *
 * The recovery state machine is retry-aware: a provider error during a
 * nudge round is an attempt-level failure — the upstream agent loop
 * auto-retries inside the same agent run, and the retry's eventual response
 * is still the answer to the armed nudge. Pending state therefore survives
 * errored attempts (discarding only that attempt's partial text via
 * `discardFailedResponseAttempt`) and is cleared at turn_end (consumed) or
 * at settlement (abandoned run — see the agent_settled handler in
 * prompt-enrichment.ts). The old attempt-level `agent_end` cleanup is what
 * broke retried nudge rounds: it disarmed the recovery mid-round, leaking
 * the retry's `<done>` acknowledgement to the UI and drawing a second nudge
 * at a model that had just complied.
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
export const ASSISTANT_OUTPUT_WITHHELD = Symbol.for("kimchi.assistant-output-withheld")

export const CONTINUATION_NUDGE_TEXT = markHarnessSteer(
	`You ended your turn without calling a tool. If this task is complete, or you are waiting for the user (you asked a question, or they told you to stop or wait), respond with exactly ${DONE_SIGNAL} — it ends your turn and does not claim the task is complete. Do not repeat your previous answer. If a tool call is still needed, call it now.`,
)

export const SECOND_NUDGE_TEXT = markHarnessSteer(
	`If you are finished or waiting for the user, respond with exactly ${DONE_SIGNAL} — it ends your turn and does not claim the task is complete. Do not repeat your previous answer. Otherwise, you MUST call the required tool immediately. Stop writing text and execute it now.`,
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

/** Unambiguous hand-back-to-user phrasings. Deliberately conservative:
 *  anything ambiguous (e.g. "go ahead", which "I'll go ahead" uses to mean
 *  proceeding) must stay out, because a match here suppresses drift
 *  recovery for the rest of the turn. */
const AWAITING_USER_PHRASES: RegExp[] = [
	/\buntil you say\b/i,
	/\bsay the word\b/i,
	/\blet me know\b/i,
	/\byour (?:call|decision|choice)\b/i,
	/\bwaiting (?:on|for) (?:you|your)\b/i,
	/\bawait(?:ing)? (?:you|your|the user)\b/i,
	// "Tell me <if/whether/what/to/…>" — direct interrogative/imperative asks.
	// Bare "tell me" stays rejected (mid-work processing phrases).
	/\btell me (?:if|whether|which|how|when|what|to)\b/i,
]

/** A text-only turn that asks anything, or explicitly hands control back to
 *  the user, is waiting on the user — nudging it would inject an imperative
 *  that the model may act on instead of waiting .
 *  The suppression only ever runs on text-only turns (turns with tool calls
 *  never reach it in `evaluateTurn`), so the blast radius is exactly the
 *  stall-vs-wait ambiguity.
 *
 *  Accepted false-positive surface: `includes("?")` also matches `?` inside
 *  URLs with query strings, ternaries in inline code, and rhetorical
 *  questions in otherwise-drift text — each suppresses drift recovery for
 *  that turn and leaves a stalled session the user can prod. The trade is
 *  deliberately asymmetric: a missed nudge stalls, while a nudge fired while
 *  the model waited on the user produced unauthorized continued work. If
 *  unrecovered-drift reports ever surface, strip fenced code blocks, inline
 *  code spans, and URLs from the joined text before these checks. */
/** Joined text blocks of an assistant message. Shared by the text-shape
 *  checks; the extraction idiom used to repeat three times in this file. */
function assistantMessageText(message: AssistantMessage): string {
	return message.content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("")
}

export function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = assistantMessageText(message)
	return text.includes("?") || AWAITING_USER_PHRASES.some((r) => r.test(text))
}

/** True when the message's joined text is exactly the done signal — a bare
 *  protocol acknowledgement. Prose containing the token ("Done. <done>")
 *  and tool-bearing responses must not match. */
export function isBareDoneSignal(message: AssistantMessage): boolean {
	const text = assistantMessageText(message)
	return text.trim() === DONE_SIGNAL
}

/*
 * Broken-announcement carve-out (corpus-tuned on 5.5 months / ~2.6k user sessions).
 *
 * The `toolsCalledSinceLastUserInput` guard below treats every text-only stop
 * deep in a cycle as an end-of-task summary. Observed reality (corpus scan):
 * a single-model (kimi-k3) generation quirk instead resolves the design in the
 * thinking block and ends the turn with a one-line announcement of the
 * write/edit it never emits — stopReason "stop", no tool call. Every incident
 * matched a narrow shape: ≤250 chars, no question, no hand-back-to-user
 * phrasing, ending in a colon or a commitment-phrase + action-verb pair.
 * That shape fired with zero dangerous false positives over 7,198 text-only
 * stop turns replayed.
 *
 * These constants are fitting artifacts from that corpus scan, not principled
 * invariants — retune against the fixture set (co-located test) rather than by
 * intuition.
 */

/* Wait-suppression phrases appear in three corpora with different owners:
 *  AWAITING_USER_PHRASES above (suppresses the no-tools-cycle nudge),
 *  WAIT_ON_USER below (gates the post-tools carve-out), and the awaiting
 *  check embedded in the carve-out. They intentionally overlap — "say the
 *  word", "tell me …", "your …" live in every copy — and are retuned from
 *  the same corpus fixtures (co-located test). Do not merge them: each
 *  corpus sits behind a different call site with different acceptable
 *  false-hit rates.
 */

/** Deliberate hand-back-to-user stops; a nudge here pushes unauthorized work.
 *  Second-person consent forms are the highest-risk family: post-tool stops
 *  are exactly where models ask permission to push/deploy/commit, and the
 *  carve-out is what makes those turns nudgeable (security-p1). */
const WAIT_ON_USER =
	/\b(ask me|tell me to|check (?:back )?in|wait(?:ing)? for|your (?:call|go-ahead|signal|approval)|your \w+ (?:go-ahead|approval|signal|word|consent|blessing)|on your (?:signal|approval|word)|say the word|let me know|you (?:approve|confirm|say so|are ready|'re ready|object|decide|sign off|green-?light)|give (?:the word|the order|the signal|the green light|(?:me )?the go-ahead)|unless you|if you want)\b/i

/** The committed action is contingent on background/external completion —
 *  the dominant false-positive class in the replay ("reviewers running, I'll
 *  aggregate when they report"). The loop resumes via toolResult delivery /
 *  subagent notifications, so nudging only burns a recovery round.
 *  Single-word alternatives are word-anchored ("appending"/"prepending"
 *  must not hit — correctness-001). */
const WAIT_ON_BACKGROUND =
	/(running in the background|still running|is running|are running|when (?:it|they|the|both|results?|reports?|notices?|agents?|reviews?|build|ci|pipeline|smoke|jobs?|chunks?|trials?)|once (?:it|they|the|both)|as soon as|waiting on the|until (?:it|the)|i'?ll (?:report|aggregate|confirm|update|post|notify|summarize|check in)|\bawait(?:ing|s)?\b|\bpending\b|in flight|mid-trial|still (?:executing|crawling|waiting))/i

/** Completion-report openers — long "Done —" summaries that occasionally
 *  contain commitment-shaped tail prose ("next steps could be:"). */
const COMPLETION_OPENER =
	/^(done\b|complete[ds]?\b|rebase[dr]?\b|cleanup complete|pushed\b|saved\b|redone\b|bookkeeping updated|all todos are (?:now )?complete|status:|the plan is submitted|nearly done|launched:|questionnaire cancelled)/i

/** Next-action commitment + action verb, or a trailing colon.
 *  The apostrophe covers both straight and typographic forms (I’ll). */
const COMMITMENT_PHRASE = /\b(let me|i(?:'|’)?ll|i will|now i|next[, ]|then (?:i|we)|first,)\b/i
const ACTION_VERB =
	/\b(writ\w*|creat\w*|run(?:ning)?|spawn\w*|build\w*|appl\w*|add\w*|implement\w*|fix\w*|test\w*|check\w*|read\w*|updat\w*|commit\w*|push\w*|launch\w*|deploy\w*|verif\w*|extract\w*|generat\w*)\b/i

/** Every observed broken announcement was 32–233 chars — single-sentence
 *  introducers. Longer texts are summaries that may merely echo commitment
 *  phrasing; the corpus's only recall miss (a 2.3KB pseudo-tool-call turn)
 *  is accepted risk, not a reason to raise this. */
const MAX_ANNOUNCEMENT_LENGTH = 250

/**
 * Interrogatives inside inline code spans, fenced blocks, and URLs are not
 * questions to the user ("Now writing the parser (handles `a?.b`):") —
 * strip them before the '?' / awaiting-phrase check inside the carve-out,
 * as the isAwaitingUserAnswer docs record as the intended next mitigation.
 */
function stripNonProse(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
}

/**
 * Whether a text-only stop turn looks like a broken continuation: the model
 * announced an immediate action and ended the turn without emitting it.
 * Conservative by construction — any wait-on-user, wait-on-background,
 * question, or completion-report signal suppresses it.
 */
export function looksLikeBrokenAnnouncement(message: AssistantMessage): boolean {
	const text = assistantMessageText(message).trim()
	if (!text || text.length > MAX_ANNOUNCEMENT_LENGTH) return false
	const prose = stripNonProse(text)
	if (prose.includes("?") || AWAITING_USER_PHRASES.some((r) => r.test(prose))) return false
	if (WAIT_ON_USER.test(text) || WAIT_ON_BACKGROUND.test(text)) return false
	// Completion openers tolerate leading punctuation/emoji ("✅ Done …" —
	// correctness-002).
	if (COMPLETION_OPENER.test(text.replace(/^[^a-zA-Z0-9]+/, ""))) return false
	return text.endsWith(":") || (COMMITMENT_PHRASE.test(text) && ACTION_VERB.test(text))
}

/** Post-turn state machine for the "text-only drift" nudge.
 *
 * Fires at most twice per user-input cycle. The no-tool cycle guard exists
 * so legitimate end-of-task summaries after a completed tool sequence are
 * not nudged; the exception is `looksLikeBrokenAnnouncement` — an
 * announcement-shaped text-only stop after tools ran in the cycle is still
 * nudged (the broken-write-announcement quirk).
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

	/** Clears the pending recovery state (flag and accumulated response
	 *  text). Called when a recovery response is consumed at `turn_end`, and
	 *  as a fallback at settlement (`agent_settled`) for an abandoned recovery
	 *  run — a terminal provider error (non-retryable, retries exhausted, or
	 *  a retry cancelled during backoff) or any other teardown that never runs
	 *  turn_end must not leave stale state that blanks the next unrelated
	 *  extension-triggered response. Attempt-level cleanup lives in
	 *  `discardFailedResponseAttempt` — `agent_end` fires after every errored
	 *  attempt, mid-nudge-round, so it cannot host this cleanup. */
	clearNudgeResponsePending(): void {
		this.nudgeResponsePending = false
		this.accumulatedResponseText = ""
	}

	/** Discards the accumulated text of a failed attempt while keeping the
	 *  recovery armed. Called at `turn_end` when `stopReason` is "error": the
	 *  upstream agent loop auto-retries the request inside the same agent
	 *  run, and the retry's eventual response is still the answer to the
	 *  armed nudge. Partial text from the failed attempt must not
	 *  contaminate the next attempt's exact-match done-signal check. The
	 *  pending flag, nudge budget, and tool/delegation state are all
	 *  preserved; repeated errors therefore consume no additional budget. */
	discardFailedResponseAttempt(): void {
		this.accumulatedResponseText = ""
	}

	evaluateTurn(message: AssistantMessage): boolean {
		if (this.nudgeCountThisCycle >= ContinuationNudge.MAX_NUDGES) return false
		// In a fresh session, suppress the nudge until at least one tool has been called.
		if (!this.toolsCalledThisSession) return false
		// A text-only turn after tools in the cycle is normally the end-of-task
		// summary — unless it is announcement-shaped (see looksLikeBrokenAnnouncement),
		// the kimi-k3 generation quirk where the model announces a write and stops.
		if (this.toolsCalledSinceLastUserInput && !looksLikeBrokenAnnouncement(message)) return false
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
		// A bare done token is always a nudge acknowledgement, never drift —
		// never re-nudge a compliant model even when pending bookkeeping was
		// lost (e.g. state cleared by an attempt-level cleanup on a retried
		// provider error). The tool-call guard above still applies, and only an
		// exact trim matches: prose containing the token is not a bare
		// acknowledgement and keeps its existing handling.
		if (isBareDoneSignal(message)) return false
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
		if (ASSISTANT_OUTPUT_WITHHELD in message) return false

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
