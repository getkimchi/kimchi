import { describe, expect, it, vi } from "vitest"
import { installRetryPatch, isCloudflare524Retryable, isSocketClosedRetryable } from "./upstream-retry-patch.js"

describe("upstream retry patch", () => {
	it("classifies Cloudflare 524 provider errors as retryable", () => {
		expect(isCloudflare524Retryable({ stopReason: "error", errorMessage: "524 status code (no body)" })).toBe(true)
		expect(isCloudflare524Retryable({ stopReason: "stop", errorMessage: "524 status code (no body)" })).toBe(false)
		expect(isCloudflare524Retryable({ stopReason: "error", errorMessage: "bad request" })).toBe(false)
	})

	it("classifies socket-connection-closed errors as retryable", () => {
		// The Node 24 wrapped message (undici SocketError wrapped by Node)
		expect(
			isSocketClosedRetryable({
				stopReason: "error",
				errorMessage:
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
			}),
		).toBe(true)
		// Raw undici SocketError message ("other side closed")
		expect(
			isSocketClosedRetryable({
				stopReason: "error",
				errorMessage: "SocketError: other side closed",
			}),
		).toBe(true)
		// Other socket closed variants
		expect(
			isSocketClosedRetryable({
				stopReason: "error",
				errorMessage: "socket unexpectedly closed by server",
			}),
		).toBe(true)
		expect(
			isSocketClosedRetryable({
				stopReason: "error",
				errorMessage: "socket closed",
			}),
		).toBe(true)
		// Non-socket errors should not match
		expect(isSocketClosedRetryable({ stopReason: "error", errorMessage: "connection reset" })).toBe(false)
		expect(isSocketClosedRetryable({ stopReason: "error", errorMessage: "fetch failed" })).toBe(false)
		expect(isSocketClosedRetryable({ stopReason: "error", errorMessage: "request failed" })).toBe(false)
		// Non-error stopReason should not match
		expect(
			isSocketClosedRetryable({
				stopReason: "stop",
				errorMessage: "The socket connection was closed unexpectedly",
			}),
		).toBe(false)
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

		installRetryPatch(sessionClass)
		const wrapped = sessionClass.prototype._isRetryableError
		installRetryPatch(sessionClass)

		expect(sessionClass.prototype._isRetryableError).toBe(wrapped)
		expect(wrapped?.({ stopReason: "error", errorMessage: "524 status code (no body)" })).toBe(true)
		expect(wrapped?.({ stopReason: "error", errorMessage: "429 rate limit" })).toBe(true)
		expect(wrapped?.({ stopReason: "error", errorMessage: "invalid request" })).toBe(false)
		// Non-matching errors fall through to the original classifier (returns false)
		expect(wrapped?.({ stopReason: "error", errorMessage: "context overflow" })).toBe(false)
		// Socket closed errors are also retried
		expect(
			wrapped?.({
				stopReason: "error",
				errorMessage:
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
			}),
		).toBe(true)
	})
})
