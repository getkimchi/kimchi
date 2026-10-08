/**
 * Corrective-retry scheduling for completion-budget cap rejections.
 *
 * Wraps `AgentSession.prototype._isRetryableError` as the OUTERMOST classifier
 * (installed after `installInfrastructureRetryPatch`, so it wraps the generic
 * classifier): when a rejected request is eligible for a budget correction —
 * the request that failed carried the exact oversized budget on the wire, it
 * had not already been corrected, AND a retry can actually run (session retry
 * settings enabled with attempts remaining, mirroring upstream's own
 * `_willRetryAfterAgentEnd` guard) — the classifier schedules one corrective
 * lowering in the shared store and reports the error as retryable, so
 * upstream's existing retry loop (`_prepareRetry`: settings, backoff,
 * `auto_retry_start`/`auto_retry_end`, `_retryAttempt` bookkeeping) runs the
 * corrected attempt. No second retry loop is introduced.
 *
 * Every evaluation is recorded as a session-authoritative verdict in the
 * store (eligible or not) so the error surfaces can present the outcome the
 * session will actually act on — including refusals from disabled retries or
 * exhausted attempts. `_emitExtensionEvent` evaluates budget rejections before
 * message_end handlers run, so presentation can read that verdict immediately.
 *
 * `_prepareRetry` is wrapped as well: when a scheduled correction will NOT
 * run (upstream refuses the retry — retries disabled, attempts exhausted, or
 * the backoff was cancelled), the pending correction is dropped immediately
 * so it can never silently lower a later, unrelated request. Without this, a
 * pending lowering scheduled before the refusal would linger past the turn
 * into the next request.
 *
 * Finally, `_handlePostAgentRun` is wrapped for final settlement: it returns
 * true exactly when the turn continues (a retry follows), false when the
 * turn is over. The pending correction survives a true — a transient
 * failure on the corrected attempt is being retried and every retry must
 * keep the lowered budget — and is dropped on false so it never outlives its
 * request cycle.
 *
 * Breaker interaction (verified by tests): the infrastructure breaker only
 * counts and blocks infrastructure-classified failures; a budget-cap rejection
 * is a request-shaped 400, so it neither trips the breaker nor is blocked by a
 * tripped one — the corrective attempt stays available.
 */

import { AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { getRawErrorMessage } from "../error-preservation.js"
import { parseBudgetCapRejection } from "./budget-cap-error.js"
import {
	clearPendingCorrection,
	isEligibleBudgetRejection,
	recordBudgetRetryVerdict,
	scheduleCorrection,
} from "./budget-correction-store.js"

interface BudgetRejectionMessage {
	stopReason?: string
	provider?: string
	model?: string
	errorMessage?: string
}

type RetryingSession = {
	sessionManager: { getSessionId: () => string }
	settingsManager: { getRetrySettings: () => { enabled: boolean; maxRetries: number } }
	_retryAttempt: number
	_isRetryableError: RetryClassifier
}

type RetryClassifier = (this: RetryingSession, message: BudgetRejectionMessage) => boolean
type RetryPreparer = (this: RetryingSession, message: BudgetRejectionMessage) => Promise<boolean>

type PatchableAgentSession = {
	prototype: {
		_isRetryableError?: RetryClassifier
		_prepareRetry?: RetryPreparer
		_handlePostAgentRun?: (this: RetryingSession) => Promise<boolean>
		_emitExtensionEvent?: (this: RetryingSession, event: AgentSessionEvent) => Promise<void>
		__kimchiBudgetRetryPatch?: boolean
	}
}

/** The provider whose OpenAI-completions requests the adapter records. */
const KIMCHI_PROVIDER_ID = "kimchi-dev"

/**
 * Install the corrective-retry classifier. Must run AFTER
 * `installInfrastructureRetryPatch()` so the budget classifier is the outermost
 * wrapper and sees an eligible rejection before the generic gateway
 * classification can declare it terminal (`bad_request` is non-retryable and
 * would short-circuit the correction).
 */
export function installBudgetCorrectionRetryPatch(
	sessionClass: PatchableAgentSession = AgentSession as unknown as PatchableAgentSession,
): void {
	const proto = sessionClass.prototype
	if (proto.__kimchiBudgetRetryPatch) return
	const original = proto._isRetryableError
	if (!original) {
		throw new Error(
			"pi-coding-agent AgentSession internals are incompatible with the Kimchi budget-correction retry " +
				"(missing _isRetryableError — upstream internals changed)",
		)
	}

	proto._isRetryableError = function patchedIsRetryableError(message: BudgetRejectionMessage): boolean {
		const session = this as RetryingSession
		if (
			message.stopReason === "error" &&
			message.provider === KIMCHI_PROVIDER_ID &&
			typeof message.model === "string" &&
			message.model.length > 0
		) {
			const raw = getRawErrorMessage(message)
			// Same availability guard upstream's `_willRetryAfterAgentEnd`
			// applies: a correction is only eligible when a retry can actually
			// run on this session. Without it, disabled or exhausted retries
			// would still schedule a lowering that no retry ever consumes.
			const settings = session.settingsManager.getRetrySettings()
			const retryAvailable = settings.enabled && session._retryAttempt < settings.maxRetries
			const rejection = retryAvailable
				? isEligibleBudgetRejection(session.sessionManager.getSessionId(), message.model, raw)
				: undefined
			// Record the session-authoritative verdict either way, so the
			// error surface presents the outcome this session will act on.
			if (raw) {
				recordBudgetRetryVerdict(session.sessionManager.getSessionId(), message.model, raw, rejection !== undefined)
			}
			if (rejection) {
				scheduleCorrection(
					session.sessionManager.getSessionId(),
					message.model,
					rejection.requestedBudget,
					rejection.limit,
				)
				return true
			}
		}
		return original.call(this, message)
	}

	// Upstream emits extension message_end before it evaluates retries. Record
	// this session's verdict while the raw rejection is still available, so
	// every surface presents the same decision as post-run retry scheduling.
	const originalEmitExtensionEvent = proto._emitExtensionEvent
	if (!originalEmitExtensionEvent) {
		throw new Error(
			"pi-coding-agent AgentSession internals are incompatible with the Kimchi budget-correction retry (missing _emitExtensionEvent)",
		)
	}
	proto._emitExtensionEvent = async function patchedEmitExtensionEvent(event): Promise<void> {
		if (
			event.type === "message_end" &&
			event.message.role === "assistant" &&
			event.message.stopReason === "error" &&
			event.message.provider === KIMCHI_PROVIDER_ID &&
			parseBudgetCapRejection(getRawErrorMessage(event.message))
		) {
			this._isRetryableError(event.message)
		}
		await originalEmitExtensionEvent.call(this, event)
	}

	const originalPrepareRetry = proto._prepareRetry
	if (originalPrepareRetry) {
		proto._prepareRetry = async function patchedPrepareRetry(message: BudgetRejectionMessage): Promise<boolean> {
			const result = await originalPrepareRetry.call(this, message)
			if (result !== true) {
				// The retry will not run (disabled, exhausted, or cancelled
				// during backoff): drop any scheduled correction before it can
				// lower a later, unrelated request.
				clearPendingCorrection((this as RetryingSession).sessionManager.getSessionId())
			}
			return result
		}
	}

	// Final settlement: `_handlePostAgentRun` returns true exactly when the
	// turn continues (a retry or queued continuation follows); false means the
	// turn is over. A pending correction must SURVIVE a true — the corrected
	// request may be transiently failing and upstream will retry it, and
	// those retries must keep the lowered budget — and must not outlive a
	// false, or it would silently lower the next, unrelated request. The
	// agent_end extension handler cannot make this call: it fires between the
	// runs of a retry chain and cannot know whether a retry follows.
	const originalPostRun = proto._handlePostAgentRun
	if (!originalPostRun) {
		throw new Error(
			"pi-coding-agent AgentSession internals are incompatible with the Kimchi budget-correction retry " +
				"(missing _handlePostAgentRun — upstream internals changed)",
		)
	}
	proto._handlePostAgentRun = async function patchedHandlePostAgentRun(): Promise<boolean> {
		const result = await originalPostRun.call(this)
		if (result !== true) {
			clearPendingCorrection((this as RetryingSession).sessionManager.getSessionId())
		}
		return result
	}

	proto.__kimchiBudgetRetryPatch = true
}
