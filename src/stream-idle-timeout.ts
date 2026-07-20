/**
 * Streaming idle-timeout guard for LLM completion fetches.
 *
 * The OpenAI SDK used by pi-coding-agent's `openai-completions` provider does
 * NOT enforce a stream-idle deadline: if the upstream stops sending SSE bytes
 * mid-stream, the request hangs for ~660s until the OS/provider closes the
 * socket, burning most of a trial's wall-clock budget per hang.
 *
 * Under the compiled Bun binary, Bun's native `globalThis.fetch` bypasses
 * undici's global dispatcher entirely, so undici's `bodyTimeout` (set in
 * `src/proxy.ts`) has no effect. The only seam where an idle timeout can
 * actually take effect under Bun is inside `patchedFetch` (src/cli.ts), by
 * wrapping the response body `ReadableStream` with a timer that aborts the
 * fetch via `AbortController` when no chunks arrive.
 *
 * This module exports the building blocks `patchedFetch` uses:
 *
 *   - `createMergedAbortController(callerSignal?)` — returns a fresh
 *     `AbortController` that fires when the caller's signal aborts, so the
 *     existing SDK-initiated abort path keeps working.
 *   - `withStreamingIdleTimeout(response, idleTimeoutMs, controller)` —
 *     returns a new `Response` whose body arms a `setTimeout` at the start
 *     of each `pull()` (i.e. when waiting for the upstream) and clears it
 *     once a chunk arrives; if the timer fires, it aborts `controller` with a
 *     `DOMException` named `"TimeoutError"`, which surfaces as a retryable
 *     transport_failure via `classifyLLMGatewayError`.
 *   - `idleTimeoutAbortReason(phase, idleTimeoutMs)` — builds the DOMException
 *     used as the abort reason, exported so tests can assert its shape.
 */

export type IdleTimeoutPhase = "headers" | "stream"

/**
 * Build the DOMException used as the AbortController#abort(reason) payload.
 *
 * The message is crafted so `classifyLLMGatewayError` matches it as a
 * `transport_failure` (retryable, infrastructure, exit 74): it contains
 * "idle timeout", which the classifier's TRANSPORT_FAILURE_RE matches.
 */
export function idleTimeoutAbortReason(phase: IdleTimeoutPhase, idleTimeoutMs: number): DOMException {
	const message =
		phase === "headers"
			? `LLM request idle timeout: no response headers within ${idleTimeoutMs}ms`
			: `LLM stream idle timeout: no chunks for ${idleTimeoutMs}ms`
	return new DOMException(message, "TimeoutError")
}

/**
 * Returns a fresh AbortController that fires when `callerSignal` (if any)
 * aborts. The returned controller is independent of the caller's signal —
 * the caller's signal is never mutated, and our own idle-timeout abort does
 * NOT propagate back to the caller's signal.
 */
export function createMergedAbortController(callerSignal?: AbortSignal | null): AbortController {
	const controller = new AbortController()
	if (!callerSignal) return controller
	if (callerSignal.aborted) {
		controller.abort(callerSignal.reason)
		return controller
	}
	callerSignal.addEventListener(
		"abort",
		() => {
			controller.abort(callerSignal.reason)
		},
		{ once: true },
	)
	return controller
}

/**
 * Wrap `response.body` in a new ReadableStream that arms an idle timer at the
 * start of each `pull()` (when waiting for the upstream) and clears it once a
 * chunk arrives. If no chunk arrives within `idleTimeoutMs`, the timer fires
 * and aborts `controller`, which errors the underlying fetch and surfaces as a
 * transport_failure to the existing retry infrastructure.
 *
 * The timer is armed inside `pull()` (not at construction) so that a slow
 * consumer never trips the timeout — only a stalled upstream does. The wrapped
 * Response shares the original status/headers; only the body is replaced. If
 * `response.body` is null (e.g. a 204), the original response is returned
 * unchanged.
 */
export function withStreamingIdleTimeout(
	response: Response,
	idleTimeoutMs: number,
	controller: AbortController,
): Response {
	const body = response.body
	if (!body) return response

	const reader = body.getReader()
	let idleTimer: ReturnType<typeof setTimeout> | undefined

	const clearIdleTimer = () => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer)
			idleTimer = undefined
		}
	}
	const armIdleTimer = () => {
		clearIdleTimer()
		idleTimer = setTimeout(() => {
			controller.abort(idleTimeoutAbortReason("stream", idleTimeoutMs))
		}, idleTimeoutMs)
	}

	const wrappedBody = new ReadableStream<Uint8Array>({
		start(ctrl) {
			// If the controller is already aborted (e.g. the headers-phase guard
			// fired before we wrapped, or the caller cancelled), surface it.
			if (controller.signal.aborted) {
				clearIdleTimer()
				ctrl.error(controller.signal.reason)
				return
			}
			// Propagate any later abort (idle-timeout or caller) to the wrapped
			// stream so a pending `reader.read()` rejects and the consumer sees
			// the error rather than hanging forever.
			controller.signal.addEventListener(
				"abort",
				() => {
					clearIdleTimer()
					// Error the wrapped stream so a pending consumer read rejects
					// immediately. The underlying fetch/stream is cleaned up by
					// the AbortController itself (the fetch was started with
					// controller.signal) — we do NOT call reader.cancel() here to
					// avoid racing the in-flight pull() read.
					ctrl.error(controller.signal.reason)
				},
				{ once: true },
			)
		},
		async pull(ctrl) {
			// Arm before awaiting the upstream so a stall between chunks aborts.
			armIdleTimer()
			try {
				const { done, value } = await reader.read()
				clearIdleTimer()
				if (done) {
					ctrl.close()
					return
				}
				ctrl.enqueue(value)
			} catch (err) {
				clearIdleTimer()
				ctrl.error(err)
			}
		},
		cancel(reason) {
			clearIdleTimer()
			return reader.cancel(reason)
		},
	})

	return new Response(wrappedBody, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}
