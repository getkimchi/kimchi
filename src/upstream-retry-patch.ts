import { AgentSession } from "@earendil-works/pi-coding-agent"
import { isInfrastructureProviderError } from "./infrastructure-error.js"

type RetryableMessage = { stopReason?: string; errorMessage?: string }
type RetryableClassifier = (message: RetryableMessage) => boolean
type PatchableAgentSession = {
	prototype: {
		_isRetryableError?: RetryableClassifier
		_kimchiCloudflare524RetryPatch?: boolean
	}
}

// Covers Cloudflare 524 timeouts and Node fetch connection-level failures that
// warrant a retry (socket closed mid-stream, pipe broken, connection reset, etc.).
// Uses the same classifier as the infra exit policy so the two cannot drift;
// the patch is additive on top of upstream's own retry classifier, so provider
// verdicts it excludes (e.g. 429) still retry when upstream says so.
export function isNetworkErrorRetryable(message: RetryableMessage): boolean {
	return message.stopReason === "error" && !!message.errorMessage && isInfrastructureProviderError(message.errorMessage)
}

// --- Socket-error circuit breaker ---
// Upstream's retry counter is per-call and resets to zero after every call,
// succeed or fail, so a run has no total retry budget: a degraded gateway can
// burn one full retry storm per call indefinitely. The breaker counts
// consecutive transport-classified errored attempts across the whole process
// and, at the threshold, makes the patched classifier report "not retryable"
// so upstream gives up; the run then ends and the infra exit policy stamps
// exit 74. Disabled unless KIMCHI_SOCKET_BREAKER_THRESHOLD is set (CI opts in;
// interactive users keep plain retries).

export const SOCKET_BREAKER_THRESHOLD_ENV = "KIMCHI_SOCKET_BREAKER_THRESHOLD"

const socketBreaker = {
	threshold: 0,
	consecutive: 0,
	tripped: false,
}

/** Threshold from the environment: a positive integer enables the breaker. */
export function resolveSocketBreakerThreshold(env: NodeJS.ProcessEnv = process.env): number {
	const threshold = Number.parseInt(env[SOCKET_BREAKER_THRESHOLD_ENV] ?? "", 10)
	return Number.isInteger(threshold) && threshold > 0 ? threshold : 0
}

export function configureSocketBreaker(threshold: number): void {
	socketBreaker.threshold = threshold
	socketBreaker.consecutive = 0
	socketBreaker.tripped = false
}

/** Any successful assistant message closes the breaker again — same reset-on-success rule as upstream. */
export function resetSocketBreaker(): void {
	socketBreaker.consecutive = 0
	socketBreaker.tripped = false
}

export function isSocketBreakerTripped(): boolean {
	return socketBreaker.tripped
}

function socketBreakerAllowsRetry(message: RetryableMessage): boolean {
	if (socketBreaker.threshold <= 0 || !isNetworkErrorRetryable(message)) return true
	socketBreaker.consecutive++
	if (socketBreaker.consecutive < socketBreaker.threshold) return true
	if (!socketBreaker.tripped) {
		socketBreaker.tripped = true
		console.error(
			`KIMCHI: socket-error circuit breaker tripped after ${socketBreaker.consecutive} consecutive provider transport failures; giving up on retries.`,
		)
	}
	return false
}

/**
 * Temporary adapter for pi-coding-agent@0.74.0. Upstream retries 429/500/502/503/504
 * but not Cloudflare's 524 timeout, which kimchi-dev's gateway can return for a
 * long planner call, nor Node fetch connection errors (ECONNRESET, EPIPE, etc.).
 * Remove once upstream's retry classifier covers these cases.
 */
export function installCloudflare524RetryPatch(
	sessionClass: PatchableAgentSession = AgentSession as unknown as PatchableAgentSession,
	breakerThreshold: number = resolveSocketBreakerThreshold(),
): void {
	configureSocketBreaker(breakerThreshold)
	const proto = sessionClass.prototype
	if (proto._kimchiCloudflare524RetryPatch) return
	const original = proto._isRetryableError
	if (!original) return

	proto._isRetryableError = function patchedIsRetryableError(message: RetryableMessage): boolean {
		if (!(original.call(this, message) || isNetworkErrorRetryable(message))) return false
		return socketBreakerAllowsRetry(message)
	}
	proto._kimchiCloudflare524RetryPatch = true
}
