import { describe, expect, it, vi } from "vitest"
import { installCloudflare524RetryPatch, isNetworkErrorRetryable } from "./upstream-retry-patch.js"

describe("upstream retry patch", () => {
	it("classifies Cloudflare 524 provider errors as retryable", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "524 status code (no body)" })).toBe(true)
		expect(isNetworkErrorRetryable({ stopReason: "stop", errorMessage: "524 status code (no body)" })).toBe(false)
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "bad request" })).toBe(false)
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

describe("isNetworkErrorRetryable", () => {
	it("returns false when stopReason is not error", () => {
		expect(isNetworkErrorRetryable({ stopReason: "end_turn", errorMessage: "524" })).toBe(false)
	})

	it("returns false when errorMessage is absent", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error" })).toBe(false)
	})

	it("returns false for unrelated error messages", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "rate limit exceeded" })).toBe(false)
	})

	it("matches 'socket connection was closed'", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "socket connection was closed" })).toBe(true)
	})

	it("matches 'unexpectedly'", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "connection closed unexpectedly" })).toBe(true)
	})

	it("matches EPIPE", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "write EPIPE" })).toBe(true)
	})

	it("matches ERR_SOCKET_CLOSED", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "ERR_SOCKET_CLOSED" })).toBe(true)
	})

	it("matches ERR_STREAM_PREMATURE_CLOSE", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "ERR_STREAM_PREMATURE_CLOSE" })).toBe(true)
	})

	it("matches ECONNRESET", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "read ECONNRESET" })).toBe(true)
	})

	it("matches 'connection reset'", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "connection reset by peer" })).toBe(true)
	})

	it("is case-insensitive for mixed-case variants", () => {
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "Socket Connection Was Closed" })).toBe(true)
		expect(isNetworkErrorRetryable({ stopReason: "error", errorMessage: "Connection Reset" })).toBe(true)
	})
})
