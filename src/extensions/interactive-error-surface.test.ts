import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	__getPendingProviderError,
	__resetInteractiveErrorSurfaceState,
	default as interactiveErrorSurfaceExtension,
	interceptShowError,
} from "./interactive-error-surface.js"

const VLLM_RAW =
	'{"detail":"InternalServerError: Hosted_vllmException - Cannot connect to host serverless-glm-5-2-fp8.castai-llms.svc.cluster.local.:11434 ssl:<ssl.SSLContext object at 0x7a0e79ee8e40> [Connect call failed (\'10.30.0.226\', 11434)]"}'

const FORBIDDEN = ["vllm", ".svc.cluster.local", "SSLContext", "0x", "Traceback", "10.30.0.226", "11434"]

function createHarness() {
	const handlers: Record<string, (event: unknown, ctx?: unknown) => void | Promise<void>> = {}
	const pi = {
		on(event: string, handler: (event: unknown, ctx?: unknown) => void | Promise<void>) {
			handlers[event] = handler
		},
	} as unknown as ExtensionAPI
	interactiveErrorSurfaceExtension(pi)
	return {
		emitMessageEnd(message: Record<string, unknown>) {
			handlers.message_end?.({ type: "message_end", message })
		},
		emitAgentEnd(payload: Record<string, unknown>, ctx?: { ui?: { notify: ReturnType<typeof vi.fn> } }) {
			handlers.agent_end?.({ type: "agent_end", ...payload }, ctx)
		},
	}
}

describe("interceptShowError (pure decision)", () => {
	it("suppresses retryable per-attempt provider errors (returns undefined)", () => {
		expect(interceptShowError(VLLM_RAW, undefined)).toBeUndefined()
		expect(interceptShowError("500 status code (no body)", undefined)).toBeUndefined()
		expect(interceptShowError("Cloudflare 524 timeout", undefined)).toBeUndefined()
	})

	it("suppresses the stale Retrying placeholder", () => {
		expect(interceptShowError("Retrying…", undefined)).toBeUndefined()
	})

	it("sanitizes the auto_retry_end exhaustion message using pending.rawMessage for reason", () => {
		const pending = { rawMessage: VLLM_RAW, willRetry: false }
		const result = interceptShowError("Retry failed after 3 attempts: Retrying…", pending)
		expect(result).toBeDefined()
		for (const forbidden of FORBIDDEN) {
			expect(result).not.toContain(forbidden)
		}
		expect(result).toContain("The model provider is temporarily unavailable (provider unavailable)")
		expect(result).toContain("Please retry your request.")
	})

	it("sanitizes the auto_retry_end exhaustion message with vLLM raw error", () => {
		const result = interceptShowError(`Retry failed after 3 attempts: ${VLLM_RAW}`, {
			rawMessage: VLLM_RAW,
			willRetry: false,
		})
		expect(result).toBeDefined()
		for (const forbidden of FORBIDDEN) {
			expect(result).not.toContain(forbidden)
		}
		expect(result).toContain("Please retry your request.")
	})

	it("passes non-provider errors through unchanged", () => {
		expect(interceptShowError("Compaction cancelled", undefined)).toBe("Compaction cancelled")
		expect(interceptShowError("Shortcut handler error: boom", undefined)).toBe("Shortcut handler error: boom")
	})

	it("sanitizes non-retryable provider errors (bad_request) without suppressing", () => {
		const result = interceptShowError("BadRequestError: bad request, code 400", undefined)
		expect(result).toBeDefined()
		expect(result).toContain("The request could not be completed (bad request)")
		expect(result).not.toContain("BadRequestError")
	})

	it("sanitizes context_window_exceeded", () => {
		const result = interceptShowError(
			"ContextWindowExceededError: The input is longer than the model's context length",
			undefined,
		)
		expect(result).toContain("context window exceeded")
	})
})

describe("interactiveErrorSurfaceExtension (pending-state tracking)", () => {
	beforeEach(() => {
		__resetInteractiveErrorSurfaceState()
	})

	it("sets pending state only for retryable errors", () => {
		const { emitMessageEnd } = createHarness()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		expect(__getPendingProviderError()?.rawMessage).toBe(VLLM_RAW)
		expect(__getPendingProviderError()?.willRetry).toBe(true)
	})

	it("does NOT set pending state for non-retryable errors", () => {
		const { emitMessageEnd } = createHarness()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: "BadRequestError: bad request, code 400" })
		expect(__getPendingProviderError()).toBeUndefined()
	})

	it("mutates retryable errorMessage to Retrying placeholder", () => {
		const { emitMessageEnd } = createHarness()
		const message = { role: "assistant", stopReason: "error", errorMessage: VLLM_RAW }
		emitMessageEnd(message)
		expect(message.errorMessage).toBe("Retrying…")
	})

	it("mutates non-retryable errorMessage to sanitized message", () => {
		const { emitMessageEnd } = createHarness()
		const message = { role: "assistant", stopReason: "error", errorMessage: "BadRequestError: bad request, code 400" }
		emitMessageEnd(message)
		expect(message.errorMessage).toContain("The request could not be completed (bad request)")
		expect(message.errorMessage).not.toContain("BadRequestError")
	})

	it("clears pending state on a successful assistant message_end", () => {
		const { emitMessageEnd } = createHarness()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		expect(__getPendingProviderError()).toBeDefined()

		emitMessageEnd({ role: "assistant", stopReason: "stop" })
		expect(__getPendingProviderError()).toBeUndefined()
	})

	it("agent_end willRetry:true keeps pending; willRetry:false renders sanitized + clears", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		emitAgentEnd({ willRetry: true })
		expect(__getPendingProviderError()?.willRetry).toBe(true)

		// Exhaustion: agent_end with willRetry:false renders sanitized via notify.
		emitAgentEnd({ willRetry: false }, { ui: { notify } })
		expect(__getPendingProviderError()).toBeUndefined()
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("The model provider is temporarily unavailable"),
			"error",
		)
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Please retry your request."), "error")
	})

	it("agent_end does NOT render for non-retryable errors (no pending state)", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: "BadRequestError: bad request, code 400" })
		emitAgentEnd({ willRetry: false }, { ui: { notify } })
		expect(notify).not.toHaveBeenCalled()
	})

	it("ignores non-provider errors on message_end", () => {
		const { emitMessageEnd } = createHarness()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: "Something unprecedented" })
		expect(__getPendingProviderError()).toBeUndefined()
	})

	it("ignores user-role messages", () => {
		const { emitMessageEnd } = createHarness()
		emitMessageEnd({ role: "user", stopReason: "error", errorMessage: VLLM_RAW })
		expect(__getPendingProviderError()).toBeUndefined()
	})
})
