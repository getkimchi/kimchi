import { describe, expect, it, vi } from "vitest"
import { installCloudflare524RetryPatch, isCloudflare524Retryable } from "./upstream-retry-patch.js"

describe("upstream retry patch", () => {
	it("classifies Cloudflare 524 provider errors as retryable", () => {
		expect(isCloudflare524Retryable({ stopReason: "error", errorMessage: "524 status code (no body)" })).toBe(true)
		expect(isCloudflare524Retryable({ stopReason: "stop", errorMessage: "524 status code (no body)" })).toBe(false)
		expect(isCloudflare524Retryable({ stopReason: "error", errorMessage: "bad request" })).toBe(false)
	})

	it("wraps the upstream retry classifier once and preserves original retryable errors", () => {
		const original = vi.fn(
			(message: { stopReason?: string; errorMessage?: string }) => message.errorMessage === "429 rate limit",
		)
		const sessionClass = {
			prototype: {
				_isRetryableError: original,
			},
		}

		installCloudflare524RetryPatch(sessionClass)
		const wrapped = sessionClass.prototype._isRetryableError
		installCloudflare524RetryPatch(sessionClass)

		expect(sessionClass.prototype._isRetryableError).toBe(wrapped)
		expect(wrapped?.({ stopReason: "error", errorMessage: "524 status code (no body)" })).toBe(true)
		expect(wrapped?.({ stopReason: "error", errorMessage: "429 rate limit" })).toBe(true)
		expect(wrapped?.({ stopReason: "error", errorMessage: "invalid request" })).toBe(false)
	})
})
