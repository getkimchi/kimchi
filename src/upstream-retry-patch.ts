import { AgentSession } from "@earendil-works/pi-coding-agent"

type RetryableMessage = { stopReason?: string; errorMessage?: string }
type RetryableClassifier = (message: RetryableMessage) => boolean
type PatchableAgentSession = {
	prototype: {
		_isRetryableError?: RetryableClassifier
		_kimchiRetryPatchApplied?: boolean
	}
}

const CLOUDFLARE_524_RE = /\b524\b|cloudflare.*timeout|timeout.*cloudflare/i

/**
 * Matches socket-connection-closed errors from undici/Node.js native fetch.
 * These are transient — the next request on a fresh connection succeeds.
 * Covers:
 * - "The socket connection was closed unexpectedly. For more information, pass `verbose: true`..."
 *   (Node 24 wraps undici SocketError with this message)
 * - "other side closed" (raw undici SocketError message)
 * - "socket closed" and "socket unexpectedly closed"
 */
const SOCKET_CLOSED_RE = /socket.*closed|other side closed/i

export function isCloudflare524Retryable(message: RetryableMessage): boolean {
	return message.stopReason === "error" && !!message.errorMessage && CLOUDFLARE_524_RE.test(message.errorMessage)
}

export function isSocketClosedRetryable(message: RetryableMessage): boolean {
	return message.stopReason === "error" && !!message.errorMessage && SOCKET_CLOSED_RE.test(message.errorMessage)
}

/**
 * Temporary adapter for pi-coding-agent@0.74.0. Augments the upstream retry classifier
 * to also handle:
 * - Cloudflare 524 timeouts (gateway can return them for long calls)
 * - Socket-connection-closed errors (Node 24 wraps undici SocketError with
 *   "The socket connection was closed unexpectedly..."; upstream regex has "other side closed"
 *   but not "socket.*closed", so misses the Node 24 wrapped form)
 * Remove once upstream's retry classifier covers both cases.
 */
export function installRetryPatch(
	sessionClass: PatchableAgentSession = AgentSession as unknown as PatchableAgentSession,
): void {
	const proto = sessionClass.prototype
	if (proto._kimchiRetryPatchApplied) return
	const original = proto._isRetryableError
	if (!original) return

	proto._isRetryableError = function patchedIsRetryableError(message: RetryableMessage): boolean {
		return original.call(this, message) || isCloudflare524Retryable(message) || isSocketClosedRetryable(message)
	}
	proto._kimchiRetryPatchApplied = true
}
