import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	applyInfrastructureExitPolicy,
	createInfrastructureErrorTracker,
	GATEWAY_CLASSIFICATION_AUDIT_TYPE,
	type InfrastructureFailure,
	isInfrastructureProviderError,
	KIMCHI_INFRA_ERROR_EXIT_CODE,
} from "./infrastructure-error.js"
import { classifyLLMGatewayError } from "./llm-gateway-error.js"

function createFailure(errorMessage: string, overrides: Partial<InfrastructureFailure> = {}): InfrastructureFailure {
	const error = classifyLLMGatewayError(errorMessage)
	if (!error) throw new Error(`Expected test message to classify: ${errorMessage}`)
	return {
		error,
		consecutiveInfraErrors: 1,
		...overrides,
	}
}

describe("infrastructure error classification", () => {
	it.each([
		"socket connection was closed unexpectedly",
		"ECONNRESET: connection reset by peer",
		"write EPIPE",
		"ERR_SOCKET_CLOSED",
		"ERR_STREAM_PREMATURE_CLOSE",
		"socket hang up",
		"socket closed",
		"connection closed",
		"connection closed unexpectedly",
		"broken pipe",
		"connect ECONNREFUSED 127.0.0.1:443",
		"fetch failed",
		"Cloudflare 524 timeout",
		"HTTP2 request did not get a response",
		"stream ended before message_stop",
		"Overloaded",
		"529 Overloaded",
		"overloaded_error",
		"502 Bad Gateway",
		"503 Service Unavailable",
		"500 internal server error",
		"504 Gateway Timeout",
		"socket hang up during TLS authentication",
		"connect ETIMEDOUT 10.0.0.1:443",
		"getaddrinfo EAI_AGAIN api.example.com",
		"429 rate limit exceeded",
	])("classifies provider transport error: %s", (message) => {
		expect(isInfrastructureProviderError(message)).toBe(true)
	})

	it.each([
		"insufficient_quota: billing hard limit reached",
		"context window exceeded",
		"401 unauthorized",
		"403 permission denied",
		"invalid api key",
		"Your account has been terminated",
		"account suspended for policy violation",
	])("rejects non-infra provider error: %s", (message) => {
		expect(isInfrastructureProviderError(message)).toBe(false)
	})
})

describe("infrastructure error tracker", () => {
	const sessionFile = "/tmp/project/session.jsonl"

	function createTrackerHarness(options: { appendEntry?: (customType: string, data: unknown) => void } = {}) {
		const tracker = createInfrastructureErrorTracker()
		const auditEntries: Array<{ customType: string; data: unknown }> = []
		let handler: ((event: unknown, ctx: unknown) => void) | undefined
		const pi = {
			on: (event: string, h: (event: unknown, ctx: unknown) => void) => {
				if (event === "message_end") handler = h
			},
			appendEntry:
				options.appendEntry ??
				((customType: string, data: unknown) => {
					auditEntries.push({ customType, data })
				}),
		} as unknown as ExtensionAPI
		tracker.extension(pi)
		const ctx = { sessionManager: { getSessionFile: () => sessionFile } }
		const emit = (message: Record<string, unknown>, overrideCtx: unknown = ctx) =>
			handler?.({ type: "message_end", message }, overrideCtx)
		return { tracker, emit, auditEntries }
	}

	function assistantError(errorMessage: string): Record<string, unknown> {
		return { role: "assistant", content: [], stopReason: "error", errorMessage }
	}

	function assistantStop(text: string): Record<string, unknown> {
		return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }
	}

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("appends a classification audit entry for every classified error, including unrecognized ones", () => {
		const { emit, auditEntries } = createTrackerHarness()
		emit(assistantError("503 Service Unavailable"))
		emit(assistantError("some error string the classifier does not recognize"))

		expect(auditEntries).toEqual([
			{
				customType: GATEWAY_CLASSIFICATION_AUDIT_TYPE,
				data: {
					rawMessage: "503 Service Unavailable",
					reason: "provider_5xx",
					retryable: true,
					isInfrastructure: true,
					exitCode: KIMCHI_INFRA_ERROR_EXIT_CODE,
					httpStatusCode: 503,
				},
			},
			{
				customType: GATEWAY_CLASSIFICATION_AUDIT_TYPE,
				data: {
					rawMessage: "some error string the classifier does not recognize",
					reason: "unclassified",
					retryable: false,
					isInfrastructure: false,
					exitCode: null,
					httpStatusCode: null,
				},
			},
		])
	})

	it("does not audit successful or non-error assistant messages", () => {
		const { emit, auditEntries } = createTrackerHarness()
		emit(assistantStop("all good"))
		emit({ role: "user", content: "hello" })

		expect(auditEntries).toEqual([])
	})

	it("keeps tracking the failure when the audit sink throws", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		const { tracker, emit } = createTrackerHarness({
			appendEntry: () => {
				throw new Error("session log unavailable")
			},
		})

		emit(assistantError("503 Service Unavailable"))

		expect(tracker.getFailure()?.error.reason).toBe("provider_5xx")
		expect(errorSpy).toHaveBeenCalledTimes(1)
	})

	it("records a trailing infra error with the session path", () => {
		const { tracker, emit } = createTrackerHarness()
		emit(assistantError("socket connection was closed unexpectedly"))
		emit(assistantError("ECONNRESET: connection reset by peer"))

		expect(tracker.getFailure()).toMatchObject({
			error: {
				reason: "transport_failure",
				rawMessage: "ECONNRESET: connection reset by peer",
			},
			consecutiveInfraErrors: 2,
			sessionPath: sessionFile,
		})
		expect(tracker.getFailure()?.error.retryable).toBe(true)
		expect(tracker.getFailure()?.error.isInfrastructure).toBe(true)
		expect(tracker.getFailure()?.error.exitCode()).toBe(KIMCHI_INFRA_ERROR_EXIT_CODE)
	})

	it("records a trailing infra error without a session manager", () => {
		const { tracker, emit } = createTrackerHarness()
		emit(assistantError("socket connection was closed unexpectedly"), {})

		expect(tracker.getFailure()).toMatchObject({
			error: {
				reason: "transport_failure",
				rawMessage: "socket connection was closed unexpectedly",
			},
			consecutiveInfraErrors: 1,
		})
		expect(tracker.getFailure()?.error.retryable).toBe(true)
		expect(tracker.getFailure()?.error.isInfrastructure).toBe(true)
	})

	it("clears the failure when a later assistant message succeeds", () => {
		const { tracker, emit } = createTrackerHarness()
		emit(assistantError("ECONNRESET: connection reset by peer"))
		emit(assistantStop("done"))

		expect(tracker.getFailure()).toBeUndefined()
	})

	it("clears the failure when the trailing error is non-infra", () => {
		const { tracker, emit } = createTrackerHarness()
		emit(assistantError("socket connection was closed unexpectedly"))
		emit(assistantError("context window exceeded"))

		expect(tracker.getFailure()).toBeUndefined()
	})

	it("records a trailing rate limit so a failed process can exit as infra", () => {
		const { tracker, emit } = createTrackerHarness()
		emit(assistantError("kimi-k2.7 model is rate limited until 2026-07-09T13:18:18Z"))

		expect(tracker.getFailure()).toMatchObject({
			error: {
				reason: "rate_limit",
				rawMessage: "kimi-k2.7 model is rate limited until 2026-07-09T13:18:18Z",
			},
			consecutiveInfraErrors: 1,
			sessionPath: sessionFile,
		})
		expect(tracker.getFailure()?.error.retryable).toBe(true)
		expect(tracker.getFailure()?.error.isInfrastructure).toBe(true)
	})

	it("restarts the consecutive count after a recovery", () => {
		const { tracker, emit } = createTrackerHarness()
		emit(assistantError("write EPIPE"))
		emit(assistantStop("recovered"))
		emit(assistantError("socket hang up"))

		expect(tracker.getFailure()).toMatchObject({
			error: { rawMessage: "socket hang up" },
			consecutiveInfraErrors: 1,
		})
	})

	it("ignores non-assistant messages", () => {
		const { tracker, emit } = createTrackerHarness()
		emit(assistantError("write EPIPE"))
		emit({ role: "user", content: "hello" })

		expect(tracker.getFailure()).toMatchObject({ error: { rawMessage: "write EPIPE" } })
	})
})

describe("infrastructure exit policy", () => {
	let previousExitCode: typeof process.exitCode
	let consoleErrorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		previousExitCode = process.exitCode
		consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
	})

	afterEach(() => {
		process.exitCode = previousExitCode
		consoleErrorSpy.mockRestore()
	})

	it("prints the normalized infra marker and sets the infra exit code for a failure", () => {
		const applied = applyInfrastructureExitPolicy(
			createFailure("ERR_SOCKET_CLOSED", {
				consecutiveInfraErrors: 3,
				sessionPath: "/tmp/project/session.jsonl",
			}),
		)

		expect(applied).toBe(true)
		expect(process.exitCode).toBe(KIMCHI_INFRA_ERROR_EXIT_CODE)
		const message = consoleErrorSpy.mock.calls[0]?.[0] as string
		expect(message).toContain("KIMCHI_INFRA_ERROR")
		expect(message).toContain(`code ${KIMCHI_INFRA_ERROR_EXIT_CODE}`)
		expect(message).toContain("3 consecutive infra errors")
		expect(message).toContain("ERR_SOCKET_CLOSED")
		expect(message).toContain("/tmp/project/session.jsonl")
	})

	it("does not stamp infra exit for classified non-infra request errors", () => {
		const applied = applyInfrastructureExitPolicy(
			createFailure("400 Bad Request", {
				consecutiveInfraErrors: 3,
			}),
		)

		expect(applied).toBe(false)
		expect(process.exitCode).toBe(previousExitCode)
		expect(consoleErrorSpy).not.toHaveBeenCalled()
	})

	it("does nothing without a failure", () => {
		const applied = applyInfrastructureExitPolicy(undefined)

		expect(applied).toBe(false)
		expect(process.exitCode).toBe(previousExitCode)
		expect(consoleErrorSpy).not.toHaveBeenCalled()
	})
})
