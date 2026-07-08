import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	configureSocketBreaker,
	installCloudflare524RetryPatch,
	isSocketBreakerTripped,
} from "../upstream-retry-patch.js"
import socketBreakerExtension from "./socket-breaker.js"

describe("socket breaker extension", () => {
	const networkError = { stopReason: "error", errorMessage: "read ECONNRESET" }

	function createHarness(threshold: number) {
		const sessionClass = {
			prototype: { _isRetryableError: (_message: { stopReason?: string; errorMessage?: string }) => false },
		}
		installCloudflare524RetryPatch(sessionClass, threshold)
		let handler: ((event: unknown, ctx: unknown) => void) | undefined
		const pi = {
			on: (event: string, h: (event: unknown, ctx: unknown) => void) => {
				if (event === "message_end") handler = h
			},
		} as unknown as ExtensionAPI
		socketBreakerExtension(pi)
		return {
			// biome-ignore lint/style/noNonNullAssertion: installCloudflare524RetryPatch always wraps the classifier above
			isRetryable: sessionClass.prototype._isRetryableError!,
			emit: (message: Record<string, unknown>) => handler?.({ type: "message_end", message }, {}),
		}
	}

	afterEach(() => {
		configureSocketBreaker(0)
		vi.restoreAllMocks()
	})

	it("closes the breaker on a successful assistant message, requiring a full new storm to trip", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const { isRetryable, emit } = createHarness(2)

		expect(isRetryable(networkError)).toBe(true)
		emit({ role: "assistant", content: [], stopReason: "stop" })
		expect(isRetryable(networkError)).toBe(true)
		expect(isRetryable(networkError)).toBe(false)
		expect(isSocketBreakerTripped()).toBe(true)
	})

	it("does not reset on errored assistant messages or non-assistant messages", () => {
		vi.spyOn(console, "error").mockImplementation(() => {})
		const { isRetryable, emit } = createHarness(2)

		expect(isRetryable(networkError)).toBe(true)
		emit({ role: "assistant", content: [], stopReason: "error", errorMessage: "read ECONNRESET" })
		emit({ role: "user", content: "hello" })
		expect(isRetryable(networkError)).toBe(false)
		expect(isSocketBreakerTripped()).toBe(true)
	})
})
