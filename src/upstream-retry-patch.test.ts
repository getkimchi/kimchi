import { AgentSession } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { preserveRawErrorMessage } from "./extensions/error-preservation.js"
import {
	configureInfrastructureBreaker,
	INFRA_BREAKER_THRESHOLD_ENV,
	installInfrastructureRetryPatch,
	isInfrastructureBreakerTripped,
	isInfrastructureErrorRetryable,
	RATE_LIMIT_MAX_WAIT_MS,
	rateLimitWaitMs,
	recordInfrastructureBreakerFailure,
	rememberRateLimitDeadline,
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

	it("does not retry non-error messages that contain retryable error wording", () => {
		const original = vi.fn((_message: { stopReason?: string; errorMessage?: string }) => false)
		const sessionClass = { prototype: { _isRetryableError: original } }

		installInfrastructureRetryPatch(sessionClass)
		const wrapped = sessionClass.prototype._isRetryableError

		expect(wrapped?.({ stopReason: "stop", errorMessage: "503 Service Unavailable" })).toBe(false)
	})

	// Critical regression: Pi's original classifier retries any message
	// containing 429, but Kimchi must override that when the same 429 is a
	// budget-exhausted verdict — otherwise exhausted budgets burn the full
	// retry storm plus billing refreshes on every attempt.
	it("does not retry a 429 budget-exhausted error even when the original classifier would retry it", () => {
		const original = vi.fn((message: { stopReason?: string; errorMessage?: string }) =>
			/429/.test(message.errorMessage ?? ""),
		)
		const sessionClass = { prototype: { _isRetryableError: original } }

		installInfrastructureRetryPatch(sessionClass)
		// biome-ignore lint/style/noNonNullAssertion: installInfrastructureRetryPatch always wraps the classifier above
		const wrapped = sessionClass.prototype._isRetryableError!

		expect(original).not.toHaveBeenCalled()
		expect(wrapped({ stopReason: "error", errorMessage: "429 budget exhausted" })).toBe(false)
		// The original classifier must never even be consulted once Kimchi
		// produces an explicit non-retryable verdict.
		expect(original).not.toHaveBeenCalled()
	})

	it("does not let billing wording hide a terminal budget-exhausted 429 from Kimchi", () => {
		const original = vi.fn((_message: { stopReason?: string; errorMessage?: string }) => true)
		const sessionClass = { prototype: { _isRetryableError: original } }

		installInfrastructureRetryPatch(sessionClass)
		// biome-ignore lint/style/noNonNullAssertion: installInfrastructureRetryPatch always wraps the classifier above
		const wrapped = sessionClass.prototype._isRetryableError!

		expect(wrapped({ stopReason: "error", errorMessage: "429 billing budget exhausted" })).toBe(false)
		expect(original).not.toHaveBeenCalled()
	})

	it("keeps ordinary 429 rate-limit errors retryable", () => {
		// Pi's original classifier recognizes ordinary rate limits; Kimchi must
		// not suppress them. A 429 that Kimchi classifies as rate_limit stays
		// retryable, and a 429 Kimchi leaves unclassified still retries when the
		// original classifier says so.
		const original = vi.fn((message: { stopReason?: string; errorMessage?: string }) =>
			/queue full/.test(message.errorMessage ?? ""),
		)
		const sessionClass = { prototype: { _isRetryableError: original } }

		installInfrastructureRetryPatch(sessionClass)
		// biome-ignore lint/style/noNonNullAssertion: installInfrastructureRetryPatch always wraps the classifier above
		const wrapped = sessionClass.prototype._isRetryableError!

		expect(wrapped({ stopReason: "error", errorMessage: "429 rate limit exceeded" })).toBe(true)
		expect(wrapped({ stopReason: "error", errorMessage: "429 model queue full" })).toBe(true)
	})
})

describe("rate-limit deadline retry", () => {
	const NOW = Date.parse("2026-08-05T16:00:00Z")
	const DEADLINE = Date.parse("2026-08-05T16:04:00Z")
	const WAIT_MS = DEADLINE - NOW
	const deadlineError = {
		stopReason: "error" as const,
		errorMessage: "kimi-k2.7 model is rate limited until 2026-08-05T16:04:00Z",
	}

	type RetryMessage = { stopReason?: string; errorMessage?: string }

	type FakeSession = {
		settingsManager: { getRetrySettings: () => { enabled: boolean; maxRetries: number; baseDelayMs: number } }
		agent: { state: { messages: { role: string }[] } }
		_retryAttempt: number
		_retryAbortController?: AbortController
		_emit: ReturnType<typeof vi.fn>
	}

	function createSession(
		overrides: { enabled?: boolean; maxRetries?: number; retryAttempt?: number } = {},
	): FakeSession {
		return {
			settingsManager: {
				getRetrySettings: () => ({
					enabled: overrides.enabled ?? true,
					maxRetries: overrides.maxRetries ?? 3,
					baseDelayMs: 2000,
				}),
			},
			agent: { state: { messages: [{ role: "user" }, { role: "assistant" }] } },
			_retryAttempt: overrides.retryAttempt ?? 0,
			_emit: vi.fn(),
		}
	}

	function installPatchedPreparer() {
		const original = vi.fn<(message: RetryMessage) => Promise<boolean>>(async () => true)
		const sessionClass = {
			prototype: {
				_isRetryableError: (_message: RetryMessage) => true,
				_prepareRetry: original,
			},
		}
		installInfrastructureRetryPatch(sessionClass, 0)
		// biome-ignore lint/style/noNonNullAssertion: installInfrastructureRetryPatch always wraps the preparer above
		return { prepareRetry: sessionClass.prototype._prepareRetry!, original }
	}

	afterEach(() => {
		vi.useRealTimers()
		configureInfrastructureBreaker(0)
	})

	// The patch wraps a private upstream method. An upstream rename would silently disable the
	// deadline wait rather than fail, so assert the method still exists.
	it("upstream still exposes the _prepareRetry hook the patch wraps", () => {
		const proto = (AgentSession as unknown as { prototype: Record<string, unknown> }).prototype
		expect(typeof proto._prepareRetry).toBe("function")
		expect(typeof proto._isRetryableError).toBe("function")
	})

	it("does not retry when retries are disabled", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		const { prepareRetry } = installPatchedPreparer()
		const session = createSession({ enabled: false })

		await expect(prepareRetry.call(session as never, deadlineError)).resolves.toBe(false)
		expect(session._retryAttempt).toBe(0)
		expect(session._emit).not.toHaveBeenCalled()
	})

	// Only reachable at maxRetries 0: any higher budget with a spent counter takes the
	// _retryAttempt > 0 branch and never enters the deadline wait.
	it("restores the attempt counter when the retry budget is spent", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		const { prepareRetry } = installPatchedPreparer()
		const session = createSession({ maxRetries: 0 })

		await expect(prepareRetry.call(session as never, deadlineError)).resolves.toBe(false)
		expect(session._retryAttempt).toBe(0)
		expect(session._emit).not.toHaveBeenCalled()
	})

	it("sleeps to the stated deadline rather than backing off exponentially", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		const { prepareRetry, original } = installPatchedPreparer()
		const session = createSession()

		const pending = prepareRetry.call(session as never, deadlineError)

		expect(session._emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: WAIT_MS }),
		)
		// The errored assistant message must leave agent state or the retried turn resumes from it.
		expect(session.agent.state.messages).toEqual([{ role: "user" }])

		await vi.advanceTimersByTimeAsync(WAIT_MS)
		await expect(pending).resolves.toBe(true)
		expect(original).not.toHaveBeenCalled()
	})

	it("cancels the wait when the retry is aborted", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		const { prepareRetry } = installPatchedPreparer()
		const session = createSession()

		const pending = prepareRetry.call(session as never, deadlineError)
		session._retryAbortController?.abort()

		await expect(pending).resolves.toBe(false)
		expect(session._retryAttempt).toBe(0)
		expect(session._emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" }),
		)
	})

	it("hands later attempts back to upstream backoff", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		const { prepareRetry, original } = installPatchedPreparer()
		const session = createSession({ retryAttempt: 1 })

		await expect(prepareRetry.call(session as never, deadlineError)).resolves.toBe(true)
		expect(original).toHaveBeenCalledWith(deadlineError)
		expect(session._emit).not.toHaveBeenCalled()
	})

	it("hands messages without a stated deadline back to upstream backoff", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		const { prepareRetry, original } = installPatchedPreparer()
		const session = createSession()
		const plainError = { stopReason: "error" as const, errorMessage: "429 rate limit exceeded" }

		await expect(prepareRetry.call(session as never, plainError)).resolves.toBe(true)
		expect(original).toHaveBeenCalledWith(plainError)
	})

	it("refuses to retry a deadline past the wait bound", () => {
		vi.useFakeTimers()
		vi.setSystemTime(NOW)
		const sessionClass = { prototype: { _isRetryableError: (_message: RetryMessage) => true } }
		installInfrastructureRetryPatch(sessionClass, 0)
		const farOff = {
			stopReason: "error" as const,
			errorMessage: `rate limited until ${new Date(NOW + RATE_LIMIT_MAX_WAIT_MS + 60_000).toISOString()}`,
		}

		expect(sessionClass.prototype._isRetryableError?.(farOff)).toBe(false)
		expect(sessionClass.prototype._isRetryableError?.(deadlineError)).toBe(true)
	})

	// The notice extension rewrites the message into local time, which Date.parse cannot read back.
	it("resolves a remembered deadline after the message text is rewritten", () => {
		const message = { ...deadlineError }
		rememberRateLimitDeadline(message, DEADLINE)
		message.errorMessage = "kimi-k2.7 is rate limited until 3:45 PM"

		expect(rateLimitWaitMs(message, NOW)).toBe(WAIT_MS)
		// Identity, not content, is the key.
		expect(rateLimitWaitMs({ ...message }, NOW)).toBeUndefined()
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

	it("uses the preserved original error when errorMessage was mutated to a display placeholder", () => {
		// Simulates the interactive-error-surface extension mutating
		// errorMessage to "Retrying…" before the retry classifier runs.
		const message = {
			stopReason: "error" as const,
			errorMessage:
				"InternalServerError: Hosted_vllmException - Cannot connect to host serverless-glm-5-2-fp8.castai-llms.svc.cluster.local.:11434",
		}
		preserveRawErrorMessage(message)
		message.errorMessage = "Retrying…"

		expect(isInfrastructureErrorRetryable(message)).toBe(true)
	})

	it("returns false for a non-retryable error preserved then mutated", () => {
		const message = { stopReason: "error" as const, errorMessage: "400 Bad Request" }
		preserveRawErrorMessage(message)
		message.errorMessage = "Retrying…"

		expect(isInfrastructureErrorRetryable(message)).toBe(false)
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
