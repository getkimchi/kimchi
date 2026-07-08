import { afterEach, describe, expect, it, vi } from "vitest"
import {
	SOCKET_BREAKER_THRESHOLD_ENV,
	configureSocketBreaker,
	installCloudflare524RetryPatch,
	isNetworkErrorRetryable,
	isSocketBreakerTripped,
	resetSocketBreaker,
	resolveSocketBreakerThreshold,
} from "./upstream-retry-patch.js"

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

	// Token-level classifier coverage lives in infrastructure-error.test.ts;
	// this pins the incident that motivated the patch (upstream misses Bun's wording).
	it("matches Bun's mid-stream socket close verbatim", () => {
		expect(
			isNetworkErrorRetryable({
				stopReason: "error",
				errorMessage:
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
			}),
		).toBe(true)
	})
})

describe("socket breaker", () => {
	const networkError = { stopReason: "error", errorMessage: "The socket connection was closed unexpectedly" }
	const success = { stopReason: "stop" }

	function installPatchedClassifier(threshold: number) {
		const sessionClass = {
			prototype: { _isRetryableError: (_message: { stopReason?: string; errorMessage?: string }) => false },
		}
		installCloudflare524RetryPatch(sessionClass, threshold)
		// biome-ignore lint/style/noNonNullAssertion: installCloudflare524RetryPatch always wraps the classifier above
		return sessionClass.prototype._isRetryableError!
	}

	afterEach(() => {
		configureSocketBreaker(0)
		vi.restoreAllMocks()
	})

	it("parses the threshold env var, treating unset/invalid/non-positive as disabled", () => {
		expect(resolveSocketBreakerThreshold({})).toBe(0)
		expect(resolveSocketBreakerThreshold({ [SOCKET_BREAKER_THRESHOLD_ENV]: "3" })).toBe(3)
		expect(resolveSocketBreakerThreshold({ [SOCKET_BREAKER_THRESHOLD_ENV]: "0" })).toBe(0)
		expect(resolveSocketBreakerThreshold({ [SOCKET_BREAKER_THRESHOLD_ENV]: "-1" })).toBe(0)
		expect(resolveSocketBreakerThreshold({ [SOCKET_BREAKER_THRESHOLD_ENV]: "banana" })).toBe(0)
	})

	it("trips after the threshold of consecutive transport errors and stops retries", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const isRetryable = installPatchedClassifier(3)

		expect(isRetryable(networkError)).toBe(true)
		expect(isRetryable(networkError)).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
		expect(isSocketBreakerTripped()).toBe(true)
	})

	it("closes again on reset, so a recovered run gets a fresh budget", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const isRetryable = installPatchedClassifier(2)

		expect(isRetryable(networkError)).toBe(true)
		resetSocketBreaker()
		expect(isRetryable(networkError)).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
		expect(isSocketBreakerTripped()).toBe(true)
	})

	it("does not count non-transport errors that upstream retries (e.g. rate limits)", () => {
		const sessionClass = {
			prototype: {
				_isRetryableError: (message: { stopReason?: string; errorMessage?: string }) =>
					message.errorMessage === "429 rate limit",
			},
		}
		installCloudflare524RetryPatch(sessionClass, 1)
		const isRetryable = sessionClass.prototype._isRetryableError

		expect(isRetryable({ stopReason: "error", errorMessage: "429 rate limit" })).toBe(true)
		expect(isRetryable({ stopReason: "error", errorMessage: "429 rate limit" })).toBe(true)
		expect(isSocketBreakerTripped()).toBe(false)
	})

	it("never trips when disabled", () => {
		const isRetryable = installPatchedClassifier(0)

		for (let i = 0; i < 10; i++) expect(isRetryable(networkError)).toBe(true)
		expect(isSocketBreakerTripped()).toBe(false)
	})

	it("stays irrelevant for successful messages", () => {
		const isRetryable = installPatchedClassifier(1)

		expect(isRetryable(success)).toBe(false)
		expect(isSocketBreakerTripped()).toBe(false)
	})
})
