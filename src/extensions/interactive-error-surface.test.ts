import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getRawErrorMessage } from "./error-preservation.js"
import {
	__getPendingProviderError,
	__resetInteractiveErrorSurfaceState,
	applyInteractiveErrorSurfacePatch,
	default as interactiveErrorSurfaceExtension,
	interceptShowError,
} from "./interactive-error-surface.js"
import { REFUSAL_NOTICE_LEAD } from "./refused-turns.js"

const VLLM_RAW =
	'{"detail":"InternalServerError: Hosted_vllmException - Cannot connect to host serverless-glm-5-2-fp8.castai-llms.svc.cluster.local.:11434 ssl:<ssl.SSLContext object at 0x7a0e79ee8e40> [Connect call failed (\'10.30.0.226\', 11434)]"}'

const FORBIDDEN = ["vllm", ".svc.cluster.local", "SSLContext", "0x", "Traceback", "10.30.0.226", "11434"]

type HarnessContext = { sessionManager?: object; ui?: { notify: ReturnType<typeof vi.fn> } }

function createHarness() {
	const handlers: Record<string, (event: unknown, ctx?: HarnessContext) => void | Promise<void>> = {}
	const pi = {
		on(event: string, handler: (event: unknown, ctx?: HarnessContext) => void | Promise<void>) {
			handlers[event] = handler
		},
	} as unknown as ExtensionAPI
	interactiveErrorSurfaceExtension(pi)
	return {
		emitMessageEnd(message: Record<string, unknown>, ctx?: HarnessContext) {
			handlers.message_end?.({ type: "message_end", message }, ctx)
		},
		emitAgentEnd(payload: Record<string, unknown>, ctx?: HarnessContext) {
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

describe("patchedShowError (prototype patch end-to-end)", () => {
	it("suppresses undefined decisions and forwards sanitized strings to the original", () => {
		const imProto = InteractiveMode.prototype as unknown as {
			showError?: (this: unknown, errorMessage: string) => void
			__kimchiErrorSurfacePatched?: boolean
		}
		const seen: string[] = []
		const original = imProto.showError
		// Fake upstream original: the patch wraps whatever showError exists.
		imProto.showError = (errorMessage: string) => {
			seen.push(errorMessage)
		}
		imProto.__kimchiErrorSurfacePatched = undefined
		try {
			applyInteractiveErrorSurfacePatch()
			const call = (msg: string) => imProto.showError?.call({}, msg)
			call("Retrying…") // stale placeholder → suppressed
			call("Compaction cancelled") // non-provider → passthrough
			call(`Retry failed after 3 attempts: ${VLLM_RAW}`) // exhaustion, no pending → sanitized

			expect(seen).toHaveLength(2)
			expect(seen[0]).toBe("Compaction cancelled")
			expect(seen[1]).toContain("The model provider is temporarily unavailable")
			for (const forbidden of FORBIDDEN) {
				expect(seen[1]).not.toContain(forbidden)
			}
		} finally {
			imProto.showError = original
			imProto.__kimchiErrorSurfacePatched = undefined
		}
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

	// Non-retryable errors get sanitized for display but the raw error must be
	// recoverable: upstream's `_checkCompaction` → `isContextOverflow` looks for
	// provider-specific overflow phrases the sanitized label does not contain.
	// This is the regression test for over-context sessions never auto-compacting.
	it("preserves the raw errorMessage when sanitizing non-retryable errors", () => {
		const { emitMessageEnd } = createHarness()
		const raw = `{"error":{"type":"invalid_request_error","message":"The input (313972 tokens) is longer than the model's context length (262144 tokens).","retryable":false,"code":"400"}}`
		const message = { role: "assistant", stopReason: "error", errorMessage: raw }
		emitMessageEnd(message)
		expect(message.errorMessage).toContain("The request could not be completed (context window exceeded)")
		expect(getRawErrorMessage(message)).toBe(raw)
	})

	it("preserves the raw errorMessage for retryable errors too (no double-preserve)", () => {
		const { emitMessageEnd } = createHarness()
		const message = { role: "assistant", stopReason: "error", errorMessage: VLLM_RAW }
		emitMessageEnd(message)
		expect(message.errorMessage).toBe("Retrying…")
		expect(getRawErrorMessage(message)).toBe(VLLM_RAW)
	})

	it("clears pending state on a successful assistant message_end", () => {
		const { emitMessageEnd } = createHarness()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		expect(__getPendingProviderError()).toBeDefined()

		emitMessageEnd({ role: "assistant", stopReason: "stop" })
		expect(__getPendingProviderError()).toBeUndefined()
	})

	it("agent_end willRetry:true keeps pending and renders nothing", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		emitAgentEnd({ willRetry: true }, { ui: { notify } })
		expect(__getPendingProviderError()?.willRetry).toBe(true)
		expect(notify).not.toHaveBeenCalled()
	})

	it("agent_end willRetry:false renders sanitized once, keeps pending until next success", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		emitAgentEnd({ willRetry: true }, { ui: { notify } })
		expect(notify).not.toHaveBeenCalled()

		// Exhaustion: agent_end with willRetry:false renders sanitized via notify.
		emitAgentEnd({ willRetry: false }, { ui: { notify } })
		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("The model provider is temporarily unavailable"),
			"error",
		)
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Please retry your request."), "error")

		// The raw error is kept (pending.notified) so the imminent auto_retry_end
		// interception reuses the correct reason label; a later success clears it.
		expect(__getPendingProviderError()?.notified).toBe(true)
		emitMessageEnd({ role: "assistant", stopReason: "stop" })
		expect(__getPendingProviderError()).toBeUndefined()
	})

	it("a notified pending stays inert on repeated agent_end events (replay)", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		emitAgentEnd({ willRetry: false }, { ui: { notify } })
		expect(notify).toHaveBeenCalledTimes(1)

		// A replay/resume re-emits agent_end without an intervening message_end:
		// the notified entry must not render again, and a stray willRetry:true
		// must not resurrect the stale entry either.
		emitAgentEnd({ willRetry: false }, { ui: { notify } })
		emitAgentEnd({ willRetry: true }, { ui: { notify } })
		expect(notify).toHaveBeenCalledTimes(1)
		expect(__getPendingProviderError()?.notified).toBe(true)
	})

	it("suppresses the auto_retry_end duplicate once the exhaustion render already notified", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		emitAgentEnd({ willRetry: true }, { ui: { notify } })
		emitAgentEnd({ willRetry: false }, { ui: { notify } })
		expect(notify).toHaveBeenCalledTimes(1)

		// auto_retry_end → showError with the placeholder finalError: pending is
		// marked notified, so the duplicate is suppressed (no second render).
		const pending = __getPendingProviderError()
		expect(pending?.notified).toBe(true)
		expect(interceptShowError("Retry failed after 3 attempts: Retrying…", pending)).toBeUndefined()
	})

	it("Esc-cancel path: auto_retry_end via showError renders once with the correct label", () => {
		// Retry pending (agent_end willRetry:true, no render), then the user
		// cancels: no exhaustion agent_end fires — the auto_retry_end
		// interception is the only surface, and must keep the real reason tag.
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		emitAgentEnd({ willRetry: true }, { ui: { notify } })
		expect(notify).not.toHaveBeenCalled()

		const pending = __getPendingProviderError()
		expect(pending?.notified).toBeUndefined()
		const result = interceptShowError("Retry failed after 1 attempts: Retry cancelled", pending)
		expect(result).toContain("The model provider is temporarily unavailable (provider unavailable)")
		expect(result).toContain("Please retry your request.")
	})

	it("retries-disabled turn: first agent_end renders the exhaustion message", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		emitAgentEnd({ willRetry: false }, { ui: { notify } })
		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("after retries were exhausted"), "error")
	})

	it("user message clears stale pending from an aborted retry turn", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		emitAgentEnd({ willRetry: true }, { ui: { notify } })
		expect(__getPendingProviderError()).toBeDefined()

		emitMessageEnd({ role: "user", stopReason: "stop" })
		expect(__getPendingProviderError()).toBeUndefined()
	})

	it("a throwing sessionManager getter (deactivated runner) touches no pending state", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		const deactivated = (extra: Partial<HarnessContext> = {}): HarnessContext => ({
			get sessionManager(): object {
				throw new Error("runner deactivated")
			},
			...extra,
		})

		// A deactivated replay's message_end must not write the unscoped slot.
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW }, deactivated())
		expect(__getPendingProviderError()).toBeUndefined()

		// Nor can it clear or render anyone's state: a legit unscoped entry
		// survives a deactivated user-message clear that would have deleted it.
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		expect(__getPendingProviderError()).toBeDefined()
		emitMessageEnd({ role: "user", stopReason: "stop" }, deactivated())
		expect(__getPendingProviderError()).toBeDefined()

		// And a deactivated agent_end renders nothing.
		emitAgentEnd({ willRetry: false }, deactivated({ ui: { notify } }))
		expect(notify).not.toHaveBeenCalled()
	})

	it("does NOT set pending state when the rate-limit deadline is past the wait bound", () => {
		// The rate-limit notice already renders the "not retrying" guidance on the message;
		// an agent_end exhaustion notification would duplicate it.
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		const deadline = new Date(Date.now() + 20 * 60_000).toISOString()
		const message = {
			role: "assistant",
			stopReason: "error",
			errorMessage: `kimi-k2.5 model is rate limited until ${deadline}`,
		}
		emitMessageEnd(message)
		expect(__getPendingProviderError()).toBeUndefined()
		// The per-attempt placeholder mutation still applies; the notice overwrites it later.
		expect(message.errorMessage).toBe("Retrying…")

		emitAgentEnd({ willRetry: false }, { ui: { notify } })
		expect(notify).not.toHaveBeenCalled()
	})

	it("sets pending state for a rate-limit deadline under the wait bound", () => {
		const { emitMessageEnd } = createHarness()
		const deadline = new Date(Date.now() + 5 * 60_000).toISOString()
		const raw = `kimi-k2.5 model is rate limited until ${deadline}`
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: raw })
		expect(__getPendingProviderError()?.rawMessage).toBe(raw)
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

	it("leaves a refused turn untouched", () => {
		// The shape refused-turns writes on message_end, which runs first: a
		// normal stop with the never-rendered refusal marker on errorMessage.
		const { emitMessageEnd } = createHarness()
		const refused = {
			role: "assistant",
			content: [{ type: "text", text: REFUSAL_NOTICE_LEAD }],
			stopReason: "stop",
			errorMessage: "kimchi:refusal",
		}

		emitMessageEnd(refused)

		expect(refused.errorMessage).toBe("kimchi:refusal")
		expect(refused.stopReason).toBe("stop")
		expect(__getPendingProviderError()).toBeUndefined()
	})

	// A retryable attempt followed by a final error that is not retryable: the
	// turn ends on the second error, which message_end already rendered. The
	// earlier attempt's raw error must not come back as an exhaustion notice.
	it("clears a retryable attempt's pending when a non-retryable error ends the turn", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: "BadRequestError: bad request, code 400" })

		expect(__getPendingProviderError()).toBeUndefined()
		emitAgentEnd({ willRetry: false }, { ui: { notify } })
		expect(notify).not.toHaveBeenCalled()
	})

	it("clears a retryable attempt's pending when an unrecognized error ends the turn", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const notify = vi.fn()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: "Something unprecedented" })

		expect(__getPendingProviderError()).toBeUndefined()
		emitAgentEnd({ willRetry: false }, { ui: { notify } })
		expect(notify).not.toHaveBeenCalled()
	})

	// The ACP server hosts concurrent sessions in one process: a module-wide
	// slot would let one session's agent_end render and consume another's error.
	it("scopes pending per session: another session neither renders nor clears it", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const sessionA = { id: "A" }
		const sessionB = { id: "B" }
		const notifyA = vi.fn()
		const notifyB = vi.fn()

		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW }, { sessionManager: sessionA })
		emitAgentEnd({ willRetry: false }, { sessionManager: sessionB, ui: { notify: notifyB } })

		expect(notifyB).not.toHaveBeenCalled()
		expect(__getPendingProviderError(sessionA)).toBeDefined()

		emitAgentEnd({ willRetry: false }, { sessionManager: sessionA, ui: { notify: notifyA } })

		expect(notifyA).toHaveBeenCalledTimes(1)
		expect(notifyA).toHaveBeenCalledWith(expect.stringContaining("temporarily unavailable"), "error")
	})

	it("renders each session's own exhaustion message", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		const sessionA = { id: "A" }
		const sessionB = { id: "B" }
		const notifyA = vi.fn()
		const notifyB = vi.fn()

		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW }, { sessionManager: sessionA })
		emitMessageEnd(
			{ role: "assistant", stopReason: "error", errorMessage: "Stream ended without finish_reason" },
			{ sessionManager: sessionB },
		)
		emitAgentEnd({ willRetry: false }, { sessionManager: sessionA, ui: { notify: notifyA } })
		emitAgentEnd({ willRetry: false }, { sessionManager: sessionB, ui: { notify: notifyB } })

		expect(notifyA).toHaveBeenCalledTimes(1)
		expect(notifyB).toHaveBeenCalledTimes(1)
		expect(notifyB.mock.calls[0]?.[0]).toContain("(stream interrupted)")
	})

	it("leaves the entry un-notified when the surface has no notify, so showError renders it", () => {
		const { emitMessageEnd, emitAgentEnd } = createHarness()
		emitMessageEnd({ role: "assistant", stopReason: "error", errorMessage: VLLM_RAW })

		emitAgentEnd({ willRetry: false }, {})

		const pending = __getPendingProviderError()
		expect(pending?.notified).toBeUndefined()
		expect(interceptShowError("Retry failed after 3 attempts: Retrying…", pending)).toContain("temporarily unavailable")
	})
})
