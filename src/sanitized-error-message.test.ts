import { describe, expect, it } from "vitest"
import {
	type ErrorSurfaceContext,
	type FormatSanitizedErrorOptions,
	formatSanitizedErrorMessage,
	isRetryableErrorStillPending,
} from "./sanitized-error-message.js"

// The exact shape reported in the Slack thread: JSON-wrapped vLLM exception
// with a cluster hostname, an SSL context object pointer, and an IP:port pair.
const HOSTED_VLLM_RAW =
	'{"detail":"InternalServerError: Hosted_vllmException - Cannot connect to host serverless-glm-5-2-fp8.castai-llms.svc.cluster.local.:11434 ssl:<ssl.SSLContext object at 0x7a0e79ee8e40> [Connect call failed (\'10.30.0.226\', 11434)]"}'

const FORBIDDEN_SUBSTRINGS = ["vllm", ".svc.cluster.local", "SSLContext", "0x", "Traceback", "10.30.0.226", "11434"]

describe("formatSanitizedErrorMessage", () => {
	describe("never leaks provider internals (a)", () => {
		const exhaustedOpts: FormatSanitizedErrorOptions = { exhausted: true, attempt: 3 }
		it.each([
			["ferment", exhaustedOpts],
			["interactive", exhaustedOpts],
			["oneshot", exhaustedOpts],
			["subagent", exhaustedOpts],
		] as const)("excludes forbidden substrings for context=%s", (context, opts) => {
			const message = formatSanitizedErrorMessage(HOSTED_VLLM_RAW, context, opts)
			for (const forbidden of FORBIDDEN_SUBSTRINGS) {
				expect(message).not.toContain(forbidden)
			}
		})

		it("stays clean even while retries are still pending (not yet exhausted)", () => {
			const message = formatSanitizedErrorMessage(HOSTED_VLLM_RAW, "interactive", {
				exhausted: false,
				attempt: 1,
				maxAttempts: 3,
			})
			for (const forbidden of FORBIDDEN_SUBSTRINGS) {
				expect(message).not.toContain(forbidden)
			}
		})

		it("stays clean for a bare (non-JSON-wrapped) transport failure", () => {
			const message = formatSanitizedErrorMessage(
				"The socket connection was closed unexpectedly. For more information, pass verbose: true",
				"interactive",
				{ exhausted: true, attempt: 2 },
			)
			expect(message).not.toContain("socket")
			expect(message).not.toContain("verbose")
		})
	})

	describe("context-specific tails (b)", () => {
		const opts = { exhausted: true, attempt: 3 }

		it("ferment points the user at /ferment resume", () => {
			expect(formatSanitizedErrorMessage(HOSTED_VLLM_RAW, "ferment", opts)).toBe(
				"The model provider is temporarily unavailable (provider unavailable) after 3 retries. Run /ferment resume to continue.",
			)
		})

		it("interactive asks the user to retry their request", () => {
			expect(formatSanitizedErrorMessage(HOSTED_VLLM_RAW, "interactive", opts)).toBe(
				"The model provider is temporarily unavailable (provider unavailable) after 3 retries. Please retry your request.",
			)
		})

		it.each(["oneshot", "subagent"] as const)("context=%s omits any resume/retry hint", (context) => {
			const message = formatSanitizedErrorMessage(HOSTED_VLLM_RAW, context, opts)
			expect(message).toBe(`The model provider is temporarily unavailable (provider unavailable) after 3 retries.`)
		})
	})

	describe("reason-tag mapping for each classifier reason (d)", () => {
		const ctx: ErrorSurfaceContext = "interactive"

		it.each([
			["rate_limit", "429 Too Many Requests", "rate limit"],
			["transport_failure", "The socket connection was closed unexpectedly", "connection error"],
			["stream_interrupted", "stream ended without finish_reason", "stream interrupted"],
			["provider_5xx", "503 Service Unavailable", "provider unavailable"],
			["provider_error", "Hosted_vllmException - error sending request", "provider unavailable"],
		] as const)("retryable reason %s surfaces as '%s'", (_reason, raw, label) => {
			const message = formatSanitizedErrorMessage(raw, ctx, { exhausted: true, attempt: 2 })
			expect(message).toBe(
				`The model provider is temporarily unavailable (${label}) after 2 retries. Please retry your request.`,
			)
		})

		it.each([
			["bad_request", "BadRequestError: bad request", "bad request"],
			[
				"context_window_exceeded",
				"ContextWindowExceededError: The input is longer than the model's context length",
				"context window exceeded",
			],
			["invalid_request_payload", "tools must not be an empty array", "invalid request payload"],
		] as const)("non-retryable reason %s surfaces as '%s' with no retry count", (_reason, raw, label) => {
			// Non-retryable: exhausted is ignored, attempt is dropped — surfaced immediately.
			const message = formatSanitizedErrorMessage(raw, ctx, { exhausted: false, attempt: 0 })
			expect(message).toBe(`The request could not be completed (${label}). Please retry your request.`)
		})

		it("unclassified auth error surfaces as 'authentication error'", () => {
			const message = formatSanitizedErrorMessage("401 Unauthorized: invalid api key", ctx, {
				exhausted: true,
			})
			expect(message).toBe("The request could not be completed (authentication error). Please retry your request.")
		})

		it("unclassified billing error surfaces as 'billing or quota limit'", () => {
			const message = formatSanitizedErrorMessage("insufficient_quota: usage limit exceeded", ctx, {
				exhausted: true,
			})
			expect(message).toBe("The request could not be completed (billing or quota limit). Please retry your request.")
		})

		it("unclassified unknown error surfaces as 'provider error'", () => {
			const message = formatSanitizedErrorMessage("something completely unprecedented happened", ctx, {
				exhausted: true,
			})
			expect(message).toBe("The request could not be completed (provider error). Please retry your request.")
		})
	})

	describe("isRetryableErrorStillPending", () => {
		const retryableRaw =
			"InternalServerError: Hosted_vllmException - Cannot connect to host serverless-glm-5-2-fp8.castai-llms.svc.cluster.local.:11434"
		const nonRetryableRaw = "BadRequestError: bad request, code 400"

		it("returns true when willRetry:true (primary signal)", () => {
			expect(isRetryableErrorStillPending(retryableRaw, { willRetry: true })).toBe(true)
		})

		it("returns false when willRetry:false (exhausted)", () => {
			expect(isRetryableErrorStillPending(retryableRaw, { willRetry: false })).toBe(false)
		})

		it("returns false for non-retryable errors regardless of willRetry", () => {
			expect(isRetryableErrorStillPending(nonRetryableRaw, { willRetry: true })).toBe(false)
			expect(isRetryableErrorStillPending(nonRetryableRaw, { willRetry: false })).toBe(false)
		})

		it("returns false when the infra breaker has tripped (breaker overrides willRetry)", () => {
			expect(isRetryableErrorStillPending(retryableRaw, { willRetry: true, breakerTripped: true })).toBe(false)
		})

		it("falls back to retryAttempt < maxRetries when willRetry is unavailable", () => {
			expect(isRetryableErrorStillPending(retryableRaw, { retryAttempt: 1, maxRetries: 3 })).toBe(true)
			expect(isRetryableErrorStillPending(retryableRaw, { retryAttempt: 3, maxRetries: 3 })).toBe(false)
			expect(isRetryableErrorStillPending(retryableRaw, { retryAttempt: 4, maxRetries: 3 })).toBe(false)
		})

		it("defaults to false (surface) when neither willRetry nor the fallback budget is known", () => {
			expect(isRetryableErrorStillPending(retryableRaw, {})).toBe(false)
		})
	})

	describe("retry-count wording", () => {
		it("uses 'retry' (singular) when attempt is 1", () => {
			expect(
				formatSanitizedErrorMessage("503 Service Unavailable", "interactive", {
					exhausted: true,
					attempt: 1,
				}),
			).toContain("after 1 retry.")
		})

		it("falls back to maxAttempts when attempt is unknown", () => {
			expect(
				formatSanitizedErrorMessage("503 Service Unavailable", "interactive", {
					exhausted: true,
					maxAttempts: 3,
				}),
			).toContain("after 3 retries.")
		})

		it("falls back to a generic 'retries were exhausted' when neither is known", () => {
			expect(formatSanitizedErrorMessage("503 Service Unavailable", "interactive", { exhausted: true })).toContain(
				"after retries were exhausted.",
			)
		})

		it("omits the retry clause when a retryable error is surfaced before exhaustion", () => {
			// Defensive: callers should suppress pending errors, but if they do
			// surface one, the message must not claim retries were exhausted.
			expect(
				formatSanitizedErrorMessage("503 Service Unavailable", "interactive", {
					exhausted: false,
					attempt: 1,
				}),
			).toBe("The model provider is temporarily unavailable (provider unavailable). Please retry your request.")
		})
	})
})
