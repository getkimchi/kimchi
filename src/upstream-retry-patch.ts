import type { AssistantMessage } from "@earendil-works/pi-ai"
import { AgentSession } from "@earendil-works/pi-coding-agent"
import { getRawErrorMessage, hasPreservedRawErrorMessage } from "./extensions/error-preservation.js"
import { GATEWAY_CLASSIFICATION_AUDIT_TYPE } from "./infrastructure-error.js"
import { classifyLLMGatewayError, parseRateLimitRetryAt } from "./llm-gateway-error.js"

type RetryableMessage = Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">>
type RetryableClassifier = (message: RetryableMessage) => boolean
type RetryPreparer = (message: RetryableMessage) => Promise<boolean>
/** Message shape upstream `_checkCompaction` consumes; spread-copied when restored. */
type CompactionCheckMessage = RetryableMessage & Record<string, unknown>
type CompactionChecker = (message: CompactionCheckMessage, skipAbortedCheck?: boolean) => Promise<boolean>
type SessionBranchEntry = {
	type?: string
	customType?: string
	data?: { rawMessage?: unknown }
}
type BranchBackedSession = {
	sessionManager?: { getBranch?: () => SessionBranchEntry[] }
}
type PatchableAgentSession = {
	prototype: {
		_isRetryableError?: RetryableClassifier
		_prepareRetry?: RetryPreparer
		_checkCompaction?: CompactionChecker
		_kimchiInfrastructureRetryPatch?: boolean
		_kimchiCompactionRecoveryPatch?: boolean
	}
}

/**
 * Longest we will hold a turn open waiting for a stated rate-limit deadline. Beyond it the wait is
 * indistinguishable from a hang, so the error is reported once instead.
 */
export const RATE_LIMIT_MAX_WAIT_MS = 10 * 60_000

export function isInfrastructureErrorRetryable(message: RetryableMessage): boolean {
	if (message.stopReason !== "error") return false
	// The errorMessage may have been mutated to a display placeholder (e.g.
	// "Retrying…") by the interactive-error-surface extension before this
	// classifier runs. Use the preserved original if available.
	const rawMessage = getRawErrorMessage(message)
	if (!rawMessage) return false
	return classifyLLMGatewayError(rawMessage)?.retryable ?? false
}

const rateLimitDeadlines = new WeakMap<object, number>()

/**
 * Keeps a parsed deadline reachable after the message text is rewritten for display. The rewrite
 * replaces the gateway's UTC wording with local time, which `Date.parse` cannot read back.
 */
export function rememberRateLimitDeadline(message: object, retryAt: number): void {
	rateLimitDeadlines.set(message, retryAt)
}

/** Milliseconds until the gateway's stated reopening time, or undefined when it named none. */
export function rateLimitWaitMs(message: RetryableMessage, now: number = Date.now()): number | undefined {
	if (message.stopReason !== "error") return undefined
	const remembered = rateLimitDeadlines.get(message)
	if (remembered !== undefined) return remembered - now
	// The visible errorMessage may already be a display placeholder; parse the preserved original.
	const rawMessage = getRawErrorMessage(message)
	if (!rawMessage) return undefined
	const retryAt = parseRateLimitRetryAt(rawMessage, now)
	return retryAt === undefined ? undefined : retryAt - now
}

// --- Infrastructure-error circuit breaker ---
// Upstream's retry counter is per-call and resets to zero after every call,
// succeed or fail, so a run has no total retry budget: a degraded gateway can
// burn one full retry storm per call indefinitely. The breaker counts
// consecutive infrastructure-classified errored attempts across the whole process
// and, at the threshold, makes the patched classifier report "not retryable"
// so upstream gives up; the run then ends and the infra exit policy stamps
// exit 74. Disabled unless KIMCHI_INFRA_BREAKER_THRESHOLD is set (CI opts in;
// interactive users keep plain retries). This is intentionally process-scoped:
// parent and subagent sessions share one retry storm budget because they share
// the same patched AgentSession class and provider stream handles.

export const INFRA_BREAKER_THRESHOLD_ENV = "KIMCHI_INFRA_BREAKER_THRESHOLD"

const infrastructureBreaker = {
	threshold: 0,
	consecutive: 0,
	tripped: false,
}

/** Threshold from the environment: a positive integer enables the breaker. */
export function resolveInfrastructureBreakerThreshold(env: NodeJS.ProcessEnv = process.env): number {
	const threshold = Number.parseInt(env[INFRA_BREAKER_THRESHOLD_ENV] ?? "", 10)
	return Number.isInteger(threshold) && threshold > 0 ? threshold : 0
}

export function configureInfrastructureBreaker(threshold: number): void {
	infrastructureBreaker.threshold = threshold
	infrastructureBreaker.consecutive = 0
	infrastructureBreaker.tripped = false
}

/** Any successful assistant message closes the breaker again — same reset-on-success rule as upstream. */
export function resetInfrastructureBreaker(): void {
	infrastructureBreaker.consecutive = 0
	infrastructureBreaker.tripped = false
}

export function isInfrastructureBreakerTripped(): boolean {
	return infrastructureBreaker.tripped
}

/**
 * Record one infrastructure-classified retryable error. This is intentionally
 * separate from _isRetryableError: Pi calls that predicate for both UI metadata
 * and the actual retry decision, so mutating state there would double-count.
 */
export function recordInfrastructureBreakerFailure(): void {
	if (infrastructureBreaker.threshold <= 0) return
	infrastructureBreaker.consecutive++
	if (infrastructureBreaker.consecutive < infrastructureBreaker.threshold) return
	if (!infrastructureBreaker.tripped) {
		infrastructureBreaker.tripped = true
		console.error(
			`KIMCHI: infrastructure-error circuit breaker tripped after ${infrastructureBreaker.consecutive} consecutive provider infrastructure failures; giving up on retries.`,
		)
	}
}

/**
 * Temporary adapter for pi-coding-agent's retry classifier. Kimchi keeps the
 * broader infrastructure classifier and process-wide breaker locally so CI can
 * stop retry storms with exit 74 while upstream keeps handling ordinary verdicts
 * such as rate limits.
 */
export function installInfrastructureRetryPatch(
	sessionClass: PatchableAgentSession = AgentSession as unknown as PatchableAgentSession,
	breakerThreshold: number = resolveInfrastructureBreakerThreshold(),
): void {
	configureInfrastructureBreaker(breakerThreshold)
	const proto = sessionClass.prototype
	if (proto._kimchiInfrastructureRetryPatch) return
	const original = proto._isRetryableError
	if (!original) return

	proto._isRetryableError = function patchedIsRetryableError(message: RetryableMessage): boolean {
		if (message.stopReason !== "error") return false

		// The errorMessage may have been mutated to a display placeholder (e.g.
		// "Retrying…") by the interactive-error-surface extension before this
		// classifier runs. Use the preserved original if available.
		const rawMessage = getRawErrorMessage(message)
		if (!rawMessage) return false

		const classification = classifyLLMGatewayError(rawMessage)

		// Kimchi's explicit non-retryable verdicts take precedence over Pi's
		// generic 429 retry — e.g. "budget exhausted" arrives as a 429 but must
		// not be retried, so it short-circuits before the original classifier
		// can force a retry storm.
		if (classification && !classification.retryable) return false

		// A reopening time past the wait bound: no attempt before it can succeed, and each one spends
		// from the same throttled budget that is already exhausted.
		const waitMs = rateLimitWaitMs(message)
		if (waitMs !== undefined && waitMs > RATE_LIMIT_MAX_WAIT_MS) return false

		const kimchiRetryable = classification?.retryable === true
		if (!(original.call(this, message) || kimchiRetryable)) return false
		// Only infrastructure-classified errors are blocked by the breaker;
		// ordinary upstream-retryable verdicts pass through uncounted.
		if (!kimchiRetryable) return true
		return !isInfrastructureBreakerTripped()
	}

	const originalPrepareRetry = proto._prepareRetry
	if (originalPrepareRetry) {
		proto._prepareRetry = async function patchedPrepareRetry(
			this: unknown,
			message: RetryableMessage,
		): Promise<boolean> {
			const session = this as RetryingSession
			const waitMs = rateLimitWaitMs(message)
			// Only the first retry waits out a deadline; a chain of fresh deadlines would otherwise add up
			// past the bound. Everything else keeps upstream's exponential backoff.
			if (waitMs === undefined || waitMs > RATE_LIMIT_MAX_WAIT_MS || session._retryAttempt > 0) {
				return originalPrepareRetry.call(this as never, message)
			}
			return await waitForRateLimitDeadline(session, message, waitMs)
		}
	}

	proto._kimchiInfrastructureRetryPatch = true
}

type RetryingSession = {
	settingsManager: { getRetrySettings: () => { enabled: boolean; maxRetries: number } }
	agent: { state: { messages: { role: string }[] } }
	_retryAttempt: number
	_retryAbortController?: AbortController
	_emit: (event: Record<string, unknown>) => void
}

// --- Overflow-compaction recovery error restoration ---
//
// The interactive-error-surface extension sanitizes message.errorMessage on
// every classified provider error so provider internals never reach the UI.
// Upstream's compaction recovery (`AgentSession._checkCompaction`, invoked
// from `_handlePostAgentRun` / prompt()) runs AFTER that mutation and matches
// provider-specific overflow regexes (pi-ai `isContextOverflow`) against
// `assistantMessage.errorMessage`. The sanitized label ("The request could
// not be completed (context window exceeded)…") matches none of them, so an
// over-limit request terminated the session instead of triggering upstream's
// single compact-and-retry.
//
// This patch wraps `_checkCompaction` to restore the raw provider error for
// the duration of the check. Display text stays sanitized — only the internal
// overflow classifier sees the raw error, on a throwaway copy of the message.

/**
 * Raw overflow error for a message, when recoverable. Preference order:
 * 1. the in-process preserved raw message (written before sanitization by
 *    interactive-error-surface via error-preservation),
 * 2. the most recent gateway classification audit entry on the session branch
 *    (covers resumed sessions, where the in-memory symbol is gone).
 */
function rawErrorForCompactionRecovery(
	message: CompactionCheckMessage,
	session: BranchBackedSession,
): string | undefined {
	// Prefer the in-process preserved raw unconditionally: even when it equals
	// the display text (sanitization no-op), a branch audit entry belongs to an
	// EARLIER message and would inject a stale raw error here. The caller
	// already passes the message through unchanged when raw === errorMessage.
	if (hasPreservedRawErrorMessage(message)) return getRawErrorMessage(message)

	const branch = session.sessionManager?.getBranch?.() ?? []
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]
		if (entry.type === "custom" && entry.customType === GATEWAY_CLASSIFICATION_AUDIT_TYPE) {
			const raw = entry.data?.rawMessage
			if (typeof raw === "string" && raw.length > 0) return raw
		}
	}
	return undefined
}

/**
 * Companion to {@link installInfrastructureRetryPatch}: teaches upstream's
 * `_checkCompaction` to classify overflow from the preserved raw provider
 * error rather than the sanitized display text.
 *
 * The wrap is a pure delegation — classification, the one-attempt-per-turn
 * `_overflowRecoveryAttempted` gate, the dropped failed message, and
 * `_runAutoCompaction("overflow", willRetry)` all stay upstream-owned, so
 * behavior changes only for messages whose display text hid the raw error.
 */
export function installCompactionRecoveryPatch(
	sessionClass: Pick<PatchableAgentSession, "prototype"> = AgentSession as unknown as PatchableAgentSession,
): void {
	const proto = sessionClass.prototype
	if (proto._kimchiCompactionRecoveryPatch) return
	const original = proto._checkCompaction
	if (!original) return

	proto._checkCompaction = async function patchedCheckCompaction(
		this: BranchBackedSession,
		message: CompactionCheckMessage,
		skipAbortedCheck?: boolean,
	): Promise<boolean> {
		// Restore the raw provider error for the classification, leaving the
		// display text untouched. A shared copy (not the session message) is
		// passed through so nothing downstream observes the swap.
		if (typeof message.errorMessage === "string") {
			const raw = rawErrorForCompactionRecovery(message, this)
			if (raw && raw !== message.errorMessage) {
				return original.call(this, { ...message, errorMessage: raw }, skipAbortedCheck)
			}
		}
		return original.call(this, message, skipAbortedCheck)
	}

	proto._kimchiCompactionRecoveryPatch = true
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms)
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer)
				reject(signal.reason)
			},
			{ once: true },
		)
	})
}

/**
 * Sleep until the gateway's stated reopening time instead of backing off blindly, mirroring
 * upstream's `_prepareRetry` bookkeeping so the countdown UI and Esc-to-cancel keep working.
 */
async function waitForRateLimitDeadline(
	session: RetryingSession,
	message: RetryableMessage,
	waitMs: number,
): Promise<boolean> {
	const settings = session.settingsManager.getRetrySettings()
	if (!settings.enabled) return false

	session._retryAttempt++
	if (session._retryAttempt > settings.maxRetries) {
		session._retryAttempt--
		return false
	}

	session._emit({
		type: "auto_retry_start",
		attempt: session._retryAttempt,
		maxAttempts: settings.maxRetries,
		delayMs: waitMs,
		errorMessage: message.errorMessage || "Unknown error",
	})

	// The errored assistant message stays in the session for history but must leave agent state, or
	// the retried turn resumes from a failure.
	const messages = session.agent.state.messages
	if (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
		session.agent.state.messages = messages.slice(0, -1)
	}

	const controller = new AbortController()
	session._retryAbortController = controller
	try {
		await abortableSleep(waitMs, controller.signal)
	} catch {
		const attempt = session._retryAttempt
		session._retryAttempt = 0
		session._emit({ type: "auto_retry_end", success: false, attempt, finalError: "Retry cancelled" })
		return false
	} finally {
		session._retryAbortController = undefined
	}
	return true
}
