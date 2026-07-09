import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	configureInfrastructureBreaker,
	installInfrastructureRetryPatch,
	isInfrastructureBreakerTripped,
} from "../upstream-retry-patch.js"
import infrastructureBreakerExtension from "./infrastructure-breaker.js"

describe("infrastructure breaker extension", () => {
	const networkError = { stopReason: "error", errorMessage: "read ECONNRESET" }

	function createHarness(threshold: number) {
		const sessionClass = {
			prototype: { _isRetryableError: (_message: { stopReason?: string; errorMessage?: string }) => false },
		}
		installInfrastructureRetryPatch(sessionClass, threshold)
		let handler: ((event: unknown, ctx: unknown) => void) | undefined
		const pi = {
			on: (event: string, h: (event: unknown, ctx: unknown) => void) => {
				if (event === "message_end") handler = h
			},
		} as unknown as ExtensionAPI
		infrastructureBreakerExtension(pi)
		return {
			// biome-ignore lint/style/noNonNullAssertion: installInfrastructureRetryPatch always wraps the classifier above
			isRetryable: sessionClass.prototype._isRetryableError!,
			emit: (message: Record<string, unknown>) => handler?.({ type: "message_end", message }, {}),
		}
	}

	afterEach(() => {
		configureInfrastructureBreaker(0)
		vi.restoreAllMocks()
	})

	it("closes the breaker on a successful assistant message, requiring a full new storm to trip", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const { isRetryable, emit } = createHarness(2)

		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		expect(isRetryable(networkError)).toBe(true)
		emit({ role: "assistant", content: [], stopReason: "stop" })
		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		expect(isRetryable(networkError)).toBe(true)
		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		expect(isInfrastructureBreakerTripped()).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
	})

	it("does not reset on infra errored assistant messages or non-assistant messages", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const { isRetryable, emit } = createHarness(2)

		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		emit({ role: "user", content: "hello" })
		expect(isRetryable(networkError)).toBe(true)
		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		expect(isInfrastructureBreakerTripped()).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
	})

	it("resets on non-infra provider verdicts", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const { isRetryable, emit } = createHarness(2)

		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "insufficient_quota" })
		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		expect(isRetryable(networkError)).toBe(true)
		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		expect(isInfrastructureBreakerTripped()).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
	})

	it("does not reset on rate limits", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const { isRetryable, emit } = createHarness(2)

		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit exceeded" })
		expect(isInfrastructureBreakerTripped()).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
	})

	it("does not reset on provider 5xx errors", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const { isRetryable, emit } = createHarness(2)

		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "500 internal server error" })
		expect(isInfrastructureBreakerTripped()).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
	})
})
