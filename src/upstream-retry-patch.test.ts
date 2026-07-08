import { afterEach, describe, expect, it, vi } from "vitest"
import {
	INFRA_BREAKER_THRESHOLD_ENV,
	configureInfrastructureBreaker,
	installInfrastructureRetryPatch,
	isInfrastructureBreakerTripped,
	isInfrastructureErrorRetryable,
	resetInfrastructureBreaker,
	resolveInfrastructureBreakerThreshold,
} from "./upstream-retry-patch.js"

describe("upstream retry patch", () => {
	it("classifies infrastructure provider errors as retryable", () => {
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "524 status code (no body)" })).toBe(
			true,
		)
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "500 internal server error" })).toBe(
			true,
		)
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "503 Service Unavailable" })).toBe(true)
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "overloaded_error" })).toBe(true)
		expect(isInfrastructureErrorRetryable({ stopReason: "stop", errorMessage: "524 status code (no body)" })).toBe(
			false,
		)
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "bad request" })).toBe(false)
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

		installInfrastructureRetryPatch(sessionClass)
		const wrapped = sessionClass.prototype._isRetryableError
		installInfrastructureRetryPatch(sessionClass)

		expect(sessionClass.prototype._isRetryableError).toBe(wrapped)
		expect(wrapped?.({ stopReason: "error", errorMessage: "524 status code (no body)" })).toBe(true)
		expect(wrapped?.({ stopReason: "error", errorMessage: "429 rate limit" })).toBe(true)
		expect(wrapped?.({ stopReason: "error", errorMessage: "500 internal server error" })).toBe(true)
		expect(wrapped?.({ stopReason: "error", errorMessage: "invalid request" })).toBe(false)
	})
})

describe("isInfrastructureErrorRetryable", () => {
	it("returns false when stopReason is not error", () => {
		expect(isInfrastructureErrorRetryable({ stopReason: "end_turn", errorMessage: "524" })).toBe(false)
	})

	it("returns false when errorMessage is absent", () => {
		expect(isInfrastructureErrorRetryable({ stopReason: "error" })).toBe(false)
	})

	it("returns false for unrelated error messages", () => {
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "rate limit exceeded" })).toBe(false)
	})

	// Token-level classifier coverage lives in infrastructure-error.test.ts;
	// this pins the incident that motivated the patch (upstream misses Bun's wording).
	it("matches Bun's mid-stream socket close verbatim", () => {
		expect(
			isInfrastructureErrorRetryable({
				stopReason: "error",
				errorMessage:
					"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
			}),
		).toBe(true)
	})
})

describe("infrastructure breaker", () => {
	const networkError = { stopReason: "error", errorMessage: "The socket connection was closed unexpectedly" }
	const success = { stopReason: "stop" }

	function installPatchedClassifier(threshold: number) {
		const sessionClass = {
			prototype: { _isRetryableError: (_message: { stopReason?: string; errorMessage?: string }) => false },
		}
		installInfrastructureRetryPatch(sessionClass, threshold)
		// biome-ignore lint/style/noNonNullAssertion: installInfrastructureRetryPatch always wraps the classifier above
		return sessionClass.prototype._isRetryableError!
	}

	afterEach(() => {
		configureInfrastructureBreaker(0)
		vi.restoreAllMocks()
	})

	it("parses the threshold env var, treating unset/invalid/non-positive as disabled", () => {
		expect(resolveInfrastructureBreakerThreshold({})).toBe(0)
		expect(resolveInfrastructureBreakerThreshold({ [INFRA_BREAKER_THRESHOLD_ENV]: "3" })).toBe(3)
		expect(resolveInfrastructureBreakerThreshold({ [INFRA_BREAKER_THRESHOLD_ENV]: "0" })).toBe(0)
		expect(resolveInfrastructureBreakerThreshold({ [INFRA_BREAKER_THRESHOLD_ENV]: "-1" })).toBe(0)
		expect(resolveInfrastructureBreakerThreshold({ [INFRA_BREAKER_THRESHOLD_ENV]: "banana" })).toBe(0)
	})

	it("trips after the threshold of consecutive infrastructure errors and stops retries", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const isRetryable = installPatchedClassifier(3)

		expect(isRetryable(networkError)).toBe(true)
		expect(isRetryable(networkError)).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
		expect(isInfrastructureBreakerTripped()).toBe(true)
	})

	it("closes again on reset, so a recovered run gets a fresh budget", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const isRetryable = installPatchedClassifier(2)

		expect(isRetryable(networkError)).toBe(true)
		resetInfrastructureBreaker()
		expect(isRetryable(networkError)).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
		expect(isInfrastructureBreakerTripped()).toBe(true)
	})

	it("does not count non-infrastructure errors that upstream retries (e.g. rate limits)", () => {
		const sessionClass = {
			prototype: {
				_isRetryableError: (message: { stopReason?: string; errorMessage?: string }) =>
					message.errorMessage === "429 rate limit",
			},
		}
		installInfrastructureRetryPatch(sessionClass, 1)
		const isRetryable = sessionClass.prototype._isRetryableError

		expect(isRetryable({ stopReason: "error", errorMessage: "429 rate limit" })).toBe(true)
		expect(isRetryable({ stopReason: "error", errorMessage: "429 rate limit" })).toBe(true)
		expect(isInfrastructureBreakerTripped()).toBe(false)
	})

	it("counts provider 5xx errors even when upstream retries them", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const sessionClass = {
			prototype: {
				_isRetryableError: (message: { stopReason?: string; errorMessage?: string }) =>
					message.errorMessage === "500 internal server error",
			},
		}
		installInfrastructureRetryPatch(sessionClass, 2)
		const isRetryable = sessionClass.prototype._isRetryableError

		expect(isRetryable({ stopReason: "error", errorMessage: "500 internal server error" })).toBe(true)
		expect(isRetryable({ stopReason: "error", errorMessage: "500 internal server error" })).toBe(false)
		expect(isInfrastructureBreakerTripped()).toBe(true)
	})

	it("never trips when disabled", () => {
		const isRetryable = installPatchedClassifier(0)

		for (let i = 0; i < 10; i++) expect(isRetryable(networkError)).toBe(true)
		expect(isInfrastructureBreakerTripped()).toBe(false)
	})

	it("stays irrelevant for successful messages", () => {
		const isRetryable = installPatchedClassifier(1)

		expect(isRetryable(success)).toBe(false)
		expect(isInfrastructureBreakerTripped()).toBe(false)
	})
})
