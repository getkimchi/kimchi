import { AgentSession } from "@earendil-works/pi-coding-agent"
import { isInfrastructureProviderError } from "./infrastructure-error.js"

type RetryableMessage = { stopReason?: string; errorMessage?: string }
type RetryableClassifier = (message: RetryableMessage) => boolean
type PatchableAgentSession = {
	prototype: {
		_isRetryableError?: RetryableClassifier
		_kimchiInfrastructureRetryPatch?: boolean
	}
}

export function isInfrastructureErrorRetryable(message: RetryableMessage): boolean {
	return message.stopReason === "error" && !!message.errorMessage && isInfrastructureProviderError(message.errorMessage)
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

function infrastructureBreakerAllowsRetry(message: RetryableMessage): boolean {
	if (infrastructureBreaker.threshold <= 0 || !isInfrastructureErrorRetryable(message)) return true
	infrastructureBreaker.consecutive++
	if (infrastructureBreaker.consecutive < infrastructureBreaker.threshold) return true
	if (!infrastructureBreaker.tripped) {
		infrastructureBreaker.tripped = true
		console.error(
			`KIMCHI: infrastructure-error circuit breaker tripped after ${infrastructureBreaker.consecutive} consecutive provider infrastructure failures; giving up on retries.`,
		)
	}
	return false
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
		if (!(original.call(this, message) || isInfrastructureErrorRetryable(message))) return false
		return infrastructureBreakerAllowsRetry(message)
	}
	proto._kimchiInfrastructureRetryPatch = true
}
