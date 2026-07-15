import { afterEach, describe, expect, it, vi } from "vitest"
import {
	configureInfrastructureBreaker,
	INFRA_BREAKER_THRESHOLD_ENV,
	installInfrastructureRetryPatch,
	isInferenceTimeout,
	isInfrastructureBreakerTripped,
	isInfrastructureErrorRetryable,
	recordInfrastructureBreakerFailure,
	resetInfrastructureBreaker,
	resolveInfrastructureBreakerThreshold,
	MAX_INFERENCE_TIMEOUT_RETRIES,
} from "./upstream-retry-patch.js"

describe("upstream retry patch", () => {
	it("identifies only the stable inference timeout error", () => {
		const timeout = { stopReason: "error" as const, errorMessage: "inference_timeout: model exceeded deadline" }
		expect(isInferenceTimeout(timeout)).toBe(true)
		expect(isInfrastructureErrorRetryable(timeout)).toBe(false)
		expect(isInferenceTimeout({ stopReason: "aborted", errorMessage: "inference_timeout: user cancelled" })).toBe(false)
		expect(isInferenceTimeout({ stopReason: "error", errorMessage: "request timeout" })).toBe(false)
	})

	it("caps inference_timeout at two retries without changing other retry preparation", async () => {
		const originalPrepare = vi.fn(async () => true)
		const sessionClass = {
			prototype: {
				_isRetryableError: () => true,
				_prepareRetry: originalPrepare,
			},
		}
		installInfrastructureRetryPatch(sessionClass)
		const session = Object.create(sessionClass.prototype) as { _retryAttempt: number }
		const timeout = { stopReason: "error", errorMessage: "inference_timeout: model exceeded deadline" }
		const other = { stopReason: "error", errorMessage: "503 Service Unavailable" }

		session._retryAttempt = 0
		await expect(sessionClass.prototype._prepareRetry?.call(session, timeout)).resolves.toBe(true)
		session._retryAttempt = 1
		await expect(sessionClass.prototype._prepareRetry?.call(session, timeout)).resolves.toBe(true)
		session._retryAttempt = 2
		await expect(sessionClass.prototype._prepareRetry?.call(session, timeout)).resolves.toBe(false)
		expect(originalPrepare).toHaveBeenCalledTimes(MAX_INFERENCE_TIMEOUT_RETRIES)

		await expect(sessionClass.prototype._prepareRetry?.call(session, other)).resolves.toBe(true)
		expect(originalPrepare).toHaveBeenCalledTimes(MAX_INFERENCE_TIMEOUT_RETRIES + 1)

		// A new upstream retry chain gets a fresh timeout budget.
		session._retryAttempt = 0
		await expect(sessionClass.prototype._prepareRetry?.call(session, timeout)).resolves.toBe(true)
	})

	it("classifies infrastructure provider errors as retryable", () => {
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "524 status code (no body)" })).toBe(
			true,
		)
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "500 internal server error" })).toBe(
			true,
		)
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "503 Service Unavailable" })).toBe(true)
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "overloaded_error" })).toBe(true)
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "429 rate limit exceeded" })).toBe(true)
		expect(isInfrastructureErrorRetryable({ stopReason: "stop", errorMessage: "524 status code (no body)" })).toBe(
			false,
		)
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "bad request" })).toBe(false)
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "context window exceeded" })).toBe(false)
	})

	it("wraps the upstream retry classifier once and preserves original retryable errors", () => {
		const original = vi.fn(
			(message: { stopReason?: string; errorMessage?: string }) => message.errorMessage === "upstream-only retryable",
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
		expect(wrapped?.({ stopReason: "error", errorMessage: "upstream-only retryable" })).toBe(true)
		expect(wrapped?.({ stopReason: "error", errorMessage: "500 internal server error" })).toBe(true)
		expect(wrapped?.({ stopReason: "error", errorMessage: "invalid request" })).toBe(false)
	})
})

describe("isInfrastructureErrorRetryable", () => {
	it("returns false when stopReason is not error", () => {
		expect(isInfrastructureErrorRetryable({ stopReason: "stop", errorMessage: "524" })).toBe(false)
	})

	it("returns false when errorMessage is absent", () => {
		expect(isInfrastructureErrorRetryable({ stopReason: "error" })).toBe(false)
	})

	it("returns false for unrelated error messages", () => {
		expect(isInfrastructureErrorRetryable({ stopReason: "error", errorMessage: "insufficient_quota" })).toBe(false)
	})

	// Token-level classifier coverage lives in llm-gateway-error.test.ts;
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

	function installPatchedClassifier(
		threshold: number,
		upstream: (message: { stopReason?: string; errorMessage?: string }) => boolean = () => false,
	) {
		const sessionClass = { prototype: { _isRetryableError: upstream } }
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

	it("does not mutate breaker state while classifying retryability", () => {
		const isRetryable = installPatchedClassifier(1)

		expect(isRetryable(networkError)).toBe(true)
		expect(isRetryable(networkError)).toBe(true)
		expect(isInfrastructureBreakerTripped()).toBe(false)
	})

	it("trips after the threshold of consecutive infrastructure errors and stops retries", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const isRetryable = installPatchedClassifier(2)

		expect(isRetryable(networkError)).toBe(true)
		recordInfrastructureBreakerFailure()
		expect(isRetryable(networkError)).toBe(true)
		recordInfrastructureBreakerFailure()
		expect(isInfrastructureBreakerTripped()).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
	})

	it("does not count upstream-only retryable errors", () => {
		const isRetryable = installPatchedClassifier(1, (message) => message.errorMessage === "upstream-only retryable")

		expect(isRetryable({ stopReason: "error", errorMessage: "upstream-only retryable" })).toBe(true)
		expect(isRetryable({ stopReason: "error", errorMessage: "upstream-only retryable" })).toBe(true)
		expect(isInfrastructureBreakerTripped()).toBe(false)
	})

	it("counts rate limits as retryable gateway errors", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const isRetryable = installPatchedClassifier(2)

		expect(isRetryable({ stopReason: "error", errorMessage: "429 rate limit exceeded" })).toBe(true)
		recordInfrastructureBreakerFailure()
		expect(isRetryable({ stopReason: "error", errorMessage: "429 rate limit exceeded" })).toBe(true)
		recordInfrastructureBreakerFailure()
		expect(isInfrastructureBreakerTripped()).toBe(true)
		expect(isRetryable({ stopReason: "error", errorMessage: "429 rate limit exceeded" })).toBe(false)
	})

	it("counts provider 5xx errors even when upstream retries them", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const isRetryable = installPatchedClassifier(2, (message) => message.errorMessage === "500 internal server error")

		expect(isRetryable({ stopReason: "error", errorMessage: "500 internal server error" })).toBe(true)
		recordInfrastructureBreakerFailure()
		expect(isRetryable({ stopReason: "error", errorMessage: "500 internal server error" })).toBe(true)
		recordInfrastructureBreakerFailure()
		expect(isInfrastructureBreakerTripped()).toBe(true)
		expect(isRetryable({ stopReason: "error", errorMessage: "500 internal server error" })).toBe(false)
	})

	it("never trips when disabled", () => {
		const isRetryable = installPatchedClassifier(0)

		for (let i = 0; i < 10; i++) {
			recordInfrastructureBreakerFailure()
			expect(isRetryable(networkError)).toBe(true)
		}
		expect(isInfrastructureBreakerTripped()).toBe(false)
	})

	it("resetInfrastructureBreaker clears a tripped breaker", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const isRetryable = installPatchedClassifier(1)

		recordInfrastructureBreakerFailure()
		expect(isInfrastructureBreakerTripped()).toBe(true)
		expect(isRetryable(networkError)).toBe(false)

		resetInfrastructureBreaker()
		expect(isInfrastructureBreakerTripped()).toBe(false)
		expect(isRetryable(networkError)).toBe(true)
	})

	it("stays irrelevant for successful messages", () => {
		const isRetryable = installPatchedClassifier(1)

		expect(isRetryable(success)).toBe(false)
		expect(isInfrastructureBreakerTripped()).toBe(false)
	})
})
