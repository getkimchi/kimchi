import { classifyLLMGatewayError, type LLMGatewayErrorReason } from "./llm-gateway-error.js"

/**
 * Where the sanitized message is going to be shown. Each context gets a
 * different action tail: interactive sessions tell the user to retry their
 * request; ferment runs point at `/ferment resume`; one-shot / subagent
 * contexts have no user to hand control back to.
 */
export type ErrorSurfaceContext = "ferment" | "interactive" | "oneshot" | "subagent"

export interface FormatSanitizedErrorOptions {
	/**
	 * Whether the error is retryable. When omitted, derived from the gateway
	 * classifier. Callers that already classified may pass it to avoid a
	 * second classification, but the reason tag is always read from the
	 * classifier so it can never drift from the raw error.
	 */
	readonly retryable?: boolean
	/**
	 * Whether retries have been exhausted (or the infra breaker tripped, or the
	 * error is non-retryable). For non-retryable errors this is treated as
	 * true regardless, since there is nothing to wait out.
	 */
	readonly exhausted: boolean
	/** Current retry attempt (1-based), if known — used for "after N retries". */
	readonly attempt?: number
	/** Max retry attempts, if known — fallback for the retry count wording. */
	readonly maxAttempts?: number
}

/** Signals a surfacing site can use to decide whether a retryable error is still pending. */
export interface RetryPendingSignals {
	/**
	 * Primary signal: upstream `agent_end.willRetry` (true when the retry loop
	 * will continue). Computed by pi-mono at agent-session.js from
	 * `_isRetryableError(message)` and `_retryAttempt >= maxRetries`.
	 */
	readonly willRetry?: boolean
	/** Current retry attempt (1-based). Fallback when `willRetry` is unavailable. */
	readonly retryAttempt?: number
	/** Max retry attempts. Fallback when `willRetry` is unavailable. */
	readonly maxRetries?: number
	/** Whether the infra circuit breaker has tripped — tripped means exhausted (surface). */
	readonly breakerTripped?: boolean
}

interface ReasonCategory {
	readonly retryable: boolean
	readonly label: string
}

/**
 * Maps each gateway classifier reason to a plain-English category label and a
 * retryable verdict. Only user-meaningful categories appear here — never
 * provider internals (hostnames, IPs, SSL context pointers, stack traces).
 */
const REASON_CATEGORY: Record<LLMGatewayErrorReason, ReasonCategory> = {
	rate_limit: { retryable: true, label: "rate limit" },
	transport_failure: { retryable: true, label: "connection error" },
	stream_interrupted: { retryable: true, label: "stream interrupted" },
	provider_5xx: { retryable: true, label: "provider unavailable" },
	provider_error: { retryable: true, label: "provider unavailable" },
	bad_request: { retryable: false, label: "bad request" },
	context_window_exceeded: { retryable: false, label: "context window exceeded" },
	invalid_request_payload: { retryable: false, label: "invalid request payload" },
}

// Auth/billing patterns mirror the classifier's NON_GATEWAY_PROVIDER_VERDICT_RE
// but split into two categories so the sanitized message can name the real
// problem. These only run when the classifier returned nothing — i.e. the
// error was deliberately left unclassified as a non-gateway provider verdict.
const AUTH_RE = /unauthorized|authentication[_\s]?(?:error|failed)|invalid api key|\b401\b|\b403\b|permission denied/i
const BILLING_RE =
	/quota|billing|insufficient_quota|out of budget|usage limit|account.{0,40}\b(?:terminated|suspended|deactivated|disabled)\b/i

/**
 * Resolve a raw provider error to a plain-English category. Classified errors
 * use {@link REASON_CATEGORY}; unclassified errors are split into auth /
 * billing / generic so the user still gets an actionable hint without any
 * provider internals leaking through.
 */
function resolveReasonCategory(rawError: string): ReasonCategory {
	const error = classifyLLMGatewayError(rawError)
	if (error) return REASON_CATEGORY[error.reason]
	if (AUTH_RE.test(rawError)) return { retryable: false, label: "authentication error" }
	if (BILLING_RE.test(rawError)) return { retryable: false, label: "billing or quota limit" }
	return { retryable: false, label: "provider error" }
}

const CONTEXT_TAIL: Record<ErrorSurfaceContext, string> = {
	ferment: ". Run /ferment resume to continue.",
	interactive: ". Please retry your request.",
	oneshot: ".",
	subagent: ".",
}

/**
 * Build a sanitized, user-facing message for an LLM provider error. Never
 * includes the raw error string — provider internals (vLLM exception names,
 * cluster hostnames, SSL context pointers, IP:port pairs, stack traces) are
 * discarded entirely. The raw error is retained separately for on-call
 * debugging via the gateway classification audit entry.
 *
 * The reason tag is always derived from the gateway classifier so it cannot
 * drift from the raw error; the retryable verdict defaults to the classifier
 * but may be overridden by the caller.
 */
export function formatSanitizedErrorMessage(
	rawError: string,
	context: ErrorSurfaceContext,
	opts: FormatSanitizedErrorOptions,
): string {
	const category = resolveReasonCategory(rawError)
	const retryable = opts.retryable ?? category.retryable
	// Non-retryable errors surface immediately — "exhausted" is meaningless.
	const didExhaust = retryable ? opts.exhausted : true

	const head = retryable ? "The model provider is temporarily unavailable" : "The request could not be completed"

	const attempts = opts.attempt ?? opts.maxAttempts
	const retryPart =
		retryable && didExhaust
			? attempts !== undefined
				? ` after ${attempts} ${attempts === 1 ? "retry" : "retries"}`
				: " after retries were exhausted"
			: ""

	return `${head} (${category.label})${retryPart}${CONTEXT_TAIL[context]}`
}

/**
 * Decide whether a retryable provider error is still pending (retries in
 * flight) and so should NOT yet be surfaced to the user.
 *
 * Returns false (surface the sanitized message now) for:
 * - non-retryable errors (bad_request, context_window_exceeded, auth, etc.)
 * - retryable errors once retries are exhausted (`willRetry: false`)
 * - retryable errors when the infra circuit breaker has tripped
 * - retryable errors where the fallback budget is exhausted
 *   (`retryAttempt >= maxRetries`)
 *
 * Returns true (suppress, let the retry spinner continue) only when the error
 * is retryable AND `willRetry` is true, or — when `willRetry` is unknown — the
 * fallback budget still has room (`retryAttempt < maxRetries`).
 *
 * When `willRetry` is unavailable and the fallback budget can't be computed,
 * it defaults to false: surfacing a sanitized message is always safe (it never
 * leaks provider internals), whereas suppressing an error that was actually
 * exhausted would swallow it.
 *
 * @param rawError The raw provider error string (e.g. `message.errorMessage`).
 * @param signals  Retry-state signals available at the surfacing site.
 */
export function isRetryableErrorStillPending(rawError: string, signals: RetryPendingSignals): boolean {
	// Breaker tripped => treat as exhausted, surface the sanitized message.
	if (signals.breakerTripped) return false

	const error = classifyLLMGatewayError(rawError)
	const retryable = error?.retryable ?? false
	// Non-retryable errors surface immediately — never pending.
	if (!retryable) return false

	// Primary signal: upstream agent_end.willRetry.
	if (signals.willRetry === true) return true
	if (signals.willRetry === false) return false

	// Fallback when willRetry is unavailable: retryAttempt < maxRetries.
	const { retryAttempt, maxRetries } = signals
	if (retryAttempt !== undefined && maxRetries !== undefined) {
		return retryAttempt < maxRetries
	}

	// Indeterminate: default to surfacing (sanitized) rather than swallowing.
	return false
}
