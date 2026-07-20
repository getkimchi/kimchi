import { describe, expect, it, vi } from "vitest"
import { classifyLLMGatewayError } from "./llm-gateway-error.js"
import { createMergedAbortController, idleTimeoutAbortReason, withStreamingIdleTimeout } from "./stream-idle-timeout.js"

describe("idleTimeoutAbortReason", () => {
	it("produces a TimeoutError DOMException for the headers phase", () => {
		const reason = idleTimeoutAbortReason("headers", 120000)
		expect(reason).toBeInstanceOf(DOMException)
		expect(reason.name).toBe("TimeoutError")
		expect(reason.message).toContain("headers")
		expect(reason.message).toContain("120000")
	})

	it("produces a TimeoutError DOMException for the stream phase", () => {
		const reason = idleTimeoutAbortReason("stream", 120000)
		expect(reason).toBeInstanceOf(DOMException)
		expect(reason.name).toBe("TimeoutError")
		expect(reason.message).toContain("stream")
	})

	it.each([
		["headers", idleTimeoutAbortReason("headers", 60000)],
		["stream", idleTimeoutAbortReason("stream", 60000)],
	])("classifies as retryable transport_failure (%s phase)", (_phase, reason) => {
		const error = classifyLLMGatewayError(reason.message)
		expect(error?.reason).toBe("transport_failure")
		expect(error?.retryable).toBe(true)
		expect(error?.isInfrastructure).toBe(true)
		expect(error?.exitCode()).toBe(74)
	})
})

describe("createMergedAbortController", () => {
	it("returns an un-aborted controller when no caller signal is supplied", () => {
		const controller = createMergedAbortController()
		expect(controller.signal.aborted).toBe(false)
	})

	it("aborts immediately if the caller signal is already aborted", () => {
		const caller = new AbortController()
		caller.abort(new Error("pre-aborted"))
		const controller = createMergedAbortController(caller.signal)
		expect(controller.signal.aborted).toBe(true)
	})

	it("aborts when the caller signal fires later", () => {
		const caller = new AbortController()
		const controller = createMergedAbortController(caller.signal)
		expect(controller.signal.aborted).toBe(false)
		caller.abort(new Error("user cancelled"))
		expect(controller.signal.aborted).toBe(true)
	})

	it("does NOT propagate our own abort back to the caller signal", () => {
		const caller = new AbortController()
		const controller = createMergedAbortController(caller.signal)
		controller.abort(idleTimeoutAbortReason("stream", 1000))
		expect(controller.signal.aborted).toBe(true)
		expect(caller.signal.aborted).toBe(false)
	})
})

describe("withStreamingIdleTimeout", () => {
	it("returns the response unchanged when body is null", () => {
		const response = new Response(null, { status: 204 })
		const controller = new AbortController()
		const result = withStreamingIdleTimeout(response, 1000, controller)
		expect(result).toBe(response)
	})

	it("aborts the controller when the upstream stalls mid-stream", async () => {
		vi.useFakeTimers()
		try {
			// A stream whose pull() never resolves — simulates a stalled upstream
			// that accepts the request but never sends a byte.
			const body = new ReadableStream<Uint8Array>({
				pull() {
					return new Promise<void>(() => {})
				},
			})
			const response = new Response(body, { status: 200 })
			const controller = new AbortController()
			const wrapped = withStreamingIdleTimeout(response, 1000, controller)

			const wrappedBody = wrapped.body
			if (!wrappedBody) throw new Error("expected wrapped response body")
			const reader = wrappedBody.getReader()
			// Trigger pull() → arm idle timer → await stalled underlying read.
			// Attach a no-op catch up-front so the wrapped stream's error
			// (surfaced via the read rejection) is never an unhandled rejection.
			const pending = reader.read()
			pending.catch(() => {})

			// Advance past the idle window — the stall has produced no chunk.
			await vi.advanceTimersByTimeAsync(1001)

			expect(controller.signal.aborted).toBe(true)
			expect(controller.signal.reason).toBeInstanceOf(DOMException)
			expect((controller.signal.reason as DOMException).name).toBe("TimeoutError")

			// The pending read rejects because the wrapped stream was errored
			// by the abort listener.
			await expect(pending).rejects.toThrow()
		} finally {
			vi.useRealTimers()
		}
	})

	it("does NOT abort when chunks keep flowing within the idle window", async () => {
		vi.useFakeTimers()
		try {
			const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]
			const body = new ReadableStream<Uint8Array>({
				start(ctrl) {
					for (const c of chunks) ctrl.enqueue(c)
					ctrl.close()
				},
			})
			const response = new Response(body, { status: 200 })
			const controller = new AbortController()
			const wrapped = withStreamingIdleTimeout(response, 1000, controller)

			const wrappedBody = wrapped.body
			if (!wrappedBody) throw new Error("expected wrapped response body")
			const reader = wrappedBody.getReader()
			// Drain all chunks — each pull arms then immediately clears the timer.
			await reader.read()
			await reader.read()
			await reader.read()
			const { done } = await reader.read()
			expect(done).toBe(true)

			// No timer is armed after close; advancing time must not abort.
			await vi.advanceTimersByTimeAsync(5000)
			expect(controller.signal.aborted).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it("clears the idle timer on stream close", async () => {
		vi.useFakeTimers()
		try {
			const body = new ReadableStream<Uint8Array>({
				start(ctrl) {
					ctrl.enqueue(new Uint8Array([1]))
					ctrl.close()
				},
			})
			const response = new Response(body, { status: 200 })
			const controller = new AbortController()
			const wrapped = withStreamingIdleTimeout(response, 1000, controller)

			const wrappedBody = wrapped.body
			if (!wrappedBody) throw new Error("expected wrapped response body")
			const reader = wrappedBody.getReader()
			await reader.read()
			const { done } = await reader.read()
			expect(done).toBe(true)

			await vi.advanceTimersByTimeAsync(5000)
			expect(controller.signal.aborted).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it("errors the wrapped stream when the controller is already aborted", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(ctrl) {
				ctrl.enqueue(new Uint8Array([1]))
			},
		})
		const response = new Response(body, { status: 200 })
		const controller = new AbortController()
		controller.abort(idleTimeoutAbortReason("headers", 1000))
		const wrapped = withStreamingIdleTimeout(response, 1000, controller)

		const wrappedBody = wrapped.body
		if (!wrappedBody) throw new Error("expected wrapped response body")
		const reader = wrappedBody.getReader()
		await expect(reader.read()).rejects.toBeInstanceOf(DOMException)
	})
})
