/**
 * Request-scoped state for the alias-budget adapter's corrective recovery.
 *
 * Request records, pending corrections, and retry verdicts are written from
 * the provider stream boundary (the adapter) and the retry classifier (the retry patch):
 *
 * - `lastOutgoing` — the token budget the most recent outgoing request for
 *   this session actually carried on the wire, and whether the adapter had
 *   already lowered it. Written on every kimchi-dev openai-completions
 *   request. This is what makes eligibility REQUEST-scoped: a rejection only
 *   schedules a correction when the request that failed carried the exact
 *   budget the rejection complains about and that budget had not already been
 *   corrected.
 *
 * - `pending` — a scheduled correction (requested → corrected budget) applied
 *   to every outgoing attempt of the corrected request until the request
 *   completes or is cancelled (peek, not consume: a transient failure on the
 *   corrected attempt must not resurrect the original oversized budget on
 *   upstream's retry). Cleared on success/abort (message_end), turn end
 *   (`_handlePostAgentRun`), refused retries (`_prepareRetry`), model change (mismatch
 *   guard), and session shutdown.
 *
 * Nothing here erases a caller budget before a rejection: state only ever
 * changes after the backend has rejected a request or after a newer outgoing
 * request supersedes it.
 */

import { type BudgetCapRejection, parseBudgetCapRejection } from "./budget-cap-error.js"

export interface OutgoingBudgetRecord {
	readonly modelId: string
	/** Budget on the wire, or undefined when the request carried none. */
	readonly sentBudget: number | undefined
	/** True when the adapter lowered the budget for this request. */
	readonly corrected: boolean
}

export interface PendingCorrection {
	readonly modelId: string
	readonly requestedBudget: number
	readonly correctedBudget: number
}

interface SessionBudgetState {
	lastOutgoing?: OutgoingBudgetRecord
	pending?: PendingCorrection
	/** Latest classifier verdict for one rejection (see recordBudgetRetryVerdict). */
	verdict?: BudgetRetryVerdict
}

interface BudgetRetryVerdict {
	readonly modelId: string
	readonly rawMessage: string
	readonly eligible: boolean
}

/** Upper bound on tracked sessions; children and ACP sessions are short-lived. */
const MAX_TRACKED_SESSIONS = 128

const sessions = new Map<string, SessionBudgetState>()

function stateFor(sessionId: string): SessionBudgetState {
	let state = sessions.get(sessionId)
	if (!state) {
		if (sessions.size >= MAX_TRACKED_SESSIONS) {
			const oldest = sessions.keys().next()
			if (!oldest.done) sessions.delete(oldest.value)
		}
		state = {}
		sessions.set(sessionId, state)
	}
	return state
}

/** Record what the most recent outgoing request for this session put on the wire. */
export function recordOutgoingBudget(
	sessionId: string,
	modelId: string,
	sentBudget: number | undefined,
	corrected: boolean,
): void {
	// A new outgoing request supersedes any verdict recorded for a previous
	// request cycle — verdicts must never outlive the request they evaluated,
	// or an earlier refusal could decide a later identical rejection.
	const state = stateFor(sessionId)
	state.lastOutgoing = { modelId, sentBudget, corrected }
	state.verdict = undefined
}

/**
 * The corrected budget to apply when the outgoing payload still carries the
 * rejected budget for the same model. Read-only by design: the correction is
 * PEEKED, not consumed, so it applies to every retry of the same logical
 * request — a transient failure on the corrected attempt must not discard the
 * lowering and let the next attempt reconstruct the original oversized budget.
 * Lifecycle clears (completion, cancellation, turn end, model change, refused
 * retry) remove it once the request cycle is over.
 */
export function peekPendingCorrection(
	sessionId: string,
	modelId: string,
	payloadBudget: number | undefined,
): number | undefined {
	const pending = sessions.get(sessionId)?.pending
	if (!pending) return undefined
	if (pending.modelId !== modelId) return undefined
	if (payloadBudget === undefined || pending.requestedBudget !== payloadBudget) return undefined
	return pending.correctedBudget
}

/** Schedule one corrective lowering for the next outgoing request. */
export function scheduleCorrection(sessionId: string, modelId: string, requestedBudget: number, limit: number): void {
	stateFor(sessionId).pending = {
		modelId,
		requestedBudget,
		// Never raise: the corrected budget can only be lower than requested.
		correctedBudget: Math.min(requestedBudget, limit),
	}
}

/**
 * Shared, pure eligibility decision for a budget-cap rejection — used by the
 * retry classifier (to schedule) and by the error surfaces (to present "the
 * rejected request is being corrected" instead of a terminal failure), so the
 * two can never disagree.
 *
 * Eligible when: the raw message parses as a budget-cap rejection AND the
 * session's most recent outgoing request carried exactly the rejected budget
 * on the same model AND that request had not already been corrected (one
 * corrective attempt per rejected request; a rejected correction surfaces
 * terminally).
 */
export function isEligibleBudgetRejection(
	sessionId: string,
	modelId: string,
	rawMessage: string | undefined,
): BudgetCapRejection | undefined {
	const rejection = parseBudgetCapRejection(rawMessage)
	if (!rejection) return undefined
	const lastOutgoing = sessions.get(sessionId)?.lastOutgoing
	if (!lastOutgoing) return undefined
	if (lastOutgoing.modelId !== modelId) return undefined
	if (lastOutgoing.sentBudget !== rejection.requestedBudget) return undefined
	if (lastOutgoing.corrected) return undefined
	return rejection
}

/** Drop pending correction state (kept for the session; used on turn end). */
export function clearPendingCorrection(sessionId: string): void {
	const state = sessions.get(sessionId)
	if (!state) return
	sessions.set(sessionId, { ...state, pending: undefined })
}

/** Drop all budget-correction state for a session (shutdown, new session). */
export function clearBudgetCorrectionState(sessionId: string): void {
	sessions.delete(sessionId)
}

/**
 * The retry classifier's session-authoritative verdict for one rejection —
 * recorded whenever the classifier evaluates a budget rejection (eligible or
 * not), including refusals from retry settings or exhausted attempts. The
 * retry patch evaluates this verdict before emitting message_end to extensions,
 * so presentation reads the actual session settings and remaining attempts.
 * Any new outgoing request drops the verdict (see recordOutgoingBudget).
 */
export function recordBudgetRetryVerdict(
	sessionId: string,
	modelId: string,
	rawMessage: string,
	eligible: boolean,
): void {
	stateFor(sessionId).verdict = { modelId, rawMessage, eligible }
}

/** The classifier's recorded verdict for exactly this rejection, if any. */
export function getBudgetRetryVerdict(sessionId: string, modelId: string, rawMessage: string): boolean | undefined {
	const verdict = sessions.get(sessionId)?.verdict
	if (!verdict) return undefined
	if (verdict.modelId !== modelId || verdict.rawMessage !== rawMessage) return undefined
	return verdict.eligible
}

/** @internal — test hook. */
export function __resetBudgetCorrectionStoreForTests(): void {
	sessions.clear()
}

/** @internal — test inspection. */
export function __getBudgetCorrectionStateForTests(sessionId: string): Readonly<SessionBudgetState> | undefined {
	return sessions.get(sessionId)
}
