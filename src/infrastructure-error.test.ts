import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	KIMCHI_INFRA_ERROR_EXIT_CODE,
	applyInfrastructureExitPolicy,
	createInfrastructureErrorTracker,
	isInfrastructureProviderError,
} from "./infrastructure-error.js"

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
	])("classifies provider transport error: %s", (message) => {
		expect(isInfrastructureProviderError(message)).toBe(true)
	})

	it.each([
		"429 rate limit exceeded",
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

	function createTrackerHarness() {
		const tracker = createInfrastructureErrorTracker()
		let handler: ((event: unknown, ctx: unknown) => void) | undefined
		const pi = {
			on: (event: string, h: (event: unknown, ctx: unknown) => void) => {
				if (event === "message_end") handler = h
			},
		} as unknown as ExtensionAPI
		tracker.extension(pi)
		const ctx = { sessionManager: { getSessionFile: () => sessionFile } }
		const emit = (message: Record<string, unknown>) => handler?.({ type: "message_end", message }, ctx)
		return { tracker, emit }
	}

	function assistantError(errorMessage: string): Record<string, unknown> {
		return { role: "assistant", content: [], stopReason: "error", errorMessage }
	}

	function assistantStop(text: string): Record<string, unknown> {
		return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }
	}

	it("records a trailing infra error with the session path", () => {
		const { tracker, emit } = createTrackerHarness()
		emit(assistantError("socket connection was closed unexpectedly"))
		emit(assistantError("ECONNRESET: connection reset by peer"))

		expect(tracker.getFailure()).toEqual({
			errorMessage: "ECONNRESET: connection reset by peer",
			consecutiveInfraErrors: 2,
			sessionPath: sessionFile,
		})
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
		emit(assistantError("429 rate limit exceeded"))

		expect(tracker.getFailure()).toBeUndefined()
	})

	it("restarts the consecutive count after a recovery", () => {
		const { tracker, emit } = createTrackerHarness()
		emit(assistantError("write EPIPE"))
		emit(assistantStop("recovered"))
		emit(assistantError("socket hang up"))

		expect(tracker.getFailure()).toMatchObject({ errorMessage: "socket hang up", consecutiveInfraErrors: 1 })
	})

	it("ignores non-assistant messages", () => {
		const { tracker, emit } = createTrackerHarness()
		emit(assistantError("write EPIPE"))
		emit({ role: "user", content: "hello" })

		expect(tracker.getFailure()).toMatchObject({ errorMessage: "write EPIPE" })
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
		const applied = applyInfrastructureExitPolicy({
			errorMessage: "ERR_SOCKET_CLOSED",
			consecutiveInfraErrors: 3,
			sessionPath: "/tmp/project/session.jsonl",
		})

		expect(applied).toBe(true)
		expect(process.exitCode).toBe(KIMCHI_INFRA_ERROR_EXIT_CODE)
		const message = consoleErrorSpy.mock.calls[0]?.[0] as string
		expect(message).toContain("KIMCHI_INFRA_ERROR")
		expect(message).toContain(`code ${KIMCHI_INFRA_ERROR_EXIT_CODE}`)
		expect(message).toContain("3 consecutive infra errors")
		expect(message).toContain("ERR_SOCKET_CLOSED")
		expect(message).toContain("/tmp/project/session.jsonl")
	})

	it("does nothing without a failure", () => {
		const applied = applyInfrastructureExitPolicy(undefined)

		expect(applied).toBe(false)
		expect(process.exitCode).toBe(previousExitCode)
		expect(consoleErrorSpy).not.toHaveBeenCalled()
	})
})
