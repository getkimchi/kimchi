import { AgentSession } from "@earendil-works/pi-coding-agent"

type RetryableMessage = { stopReason?: string; errorMessage?: string }
type RetryableClassifier = (message: RetryableMessage) => boolean
type PatchableAgentSession = {
	prototype: {
		_isRetryableError?: RetryableClassifier
		_kimchiCloudflare524RetryPatch?: boolean
	}
}

const CLOUDFLARE_524_RE = /\b524\b|cloudflare.*timeout|timeout.*cloudflare/i

export function isCloudflare524Retryable(message: RetryableMessage): boolean {
	return message.stopReason === "error" && !!message.errorMessage && CLOUDFLARE_524_RE.test(message.errorMessage)
}

/**
 * Temporary adapter for pi-coding-agent@0.74.0. Upstream retries 429/500/502/503/504
 * but not Cloudflare's 524 timeout, which kimchi-dev's gateway can return for a
 * long planner call. Remove once upstream's retry classifier covers 524.
 */
export function installCloudflare524RetryPatch(
	sessionClass: PatchableAgentSession = AgentSession as unknown as PatchableAgentSession,
): void {
	const proto = sessionClass.prototype
	if (proto._kimchiCloudflare524RetryPatch) return
	const original = proto._isRetryableError
	if (!original) return

	proto._isRetryableError = function patchedIsRetryableError(message: RetryableMessage): boolean {
		return original.call(this, message) || isCloudflare524Retryable(message)
	}
	proto._kimchiCloudflare524RetryPatch = true
}
