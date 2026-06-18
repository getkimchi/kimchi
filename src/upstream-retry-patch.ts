import { AgentSession } from "@earendil-works/pi-coding-agent"

type RetryableMessage = { stopReason?: string; errorMessage?: string }
type RetryableClassifier = (message: RetryableMessage) => boolean
type PatchableAgentSession = {
	prototype: {
		_isRetryableError?: RetryableClassifier
		_kimchiCloudflare524RetryPatch?: boolean
	}
}

// Covers Cloudflare 524 timeouts and Node fetch connection-level failures that
// warrant a retry (socket closed mid-stream, pipe broken, connection reset, etc.)
const RETRYABLE_NETWORK_ERROR_RE =
	/\b524\b|cloudflare.*timeout|timeout.*cloudflare|socket connection was closed|unexpectedly|EPIPE|ERR_SOCKET_CLOSED|ERR_STREAM_PREMATURE_CLOSE|ECONNRESET|connection reset/i

export function isNetworkErrorRetryable(message: RetryableMessage): boolean {
	return (
		message.stopReason === "error" && !!message.errorMessage && RETRYABLE_NETWORK_ERROR_RE.test(message.errorMessage)
	)
}

/**
 * Temporary adapter for pi-coding-agent@0.74.0. Upstream retries 429/500/502/503/504
 * but not Cloudflare's 524 timeout, which kimchi-dev's gateway can return for a
 * long planner call, nor Node fetch connection errors (ECONNRESET, EPIPE, etc.).
 * Remove once upstream's retry classifier covers these cases.
 */
export function installCloudflare524RetryPatch(
	sessionClass: PatchableAgentSession = AgentSession as unknown as PatchableAgentSession,
): void {
	const proto = sessionClass.prototype
	if (proto._kimchiCloudflare524RetryPatch) return
	const original = proto._isRetryableError
	if (!original) return

	proto._isRetryableError = function patchedIsRetryableError(message: RetryableMessage): boolean {
		return original.call(this, message) || isNetworkErrorRetryable(message)
	}
	proto._kimchiCloudflare524RetryPatch = true
}
