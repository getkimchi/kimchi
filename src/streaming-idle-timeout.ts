import { RETRY_DEFAULTS } from "./config.js"

/**
 * Environment override for the streaming idle threshold. When set to a positive
 * integer, it replaces {@link RETRY_DEFAULTS.provider.timeoutMs} as the idle
 * window after which a model-completion response body with zero new data is
 * treated as a dead socket. Useful for emergency tuning without a code change.
 */
export const KIMCHI_STREAMING_IDLE_TIMEOUT_MS = "KIMCHI_STREAMING_IDLE_TIMEOUT_MS"

/**
 * Resolve the streaming-idle threshold (ms) from the environment, falling back
 * to `RETRY_DEFAULTS.provider.timeoutMs`. A non-positive resolved value
 * disables the wrapper (returns the response untouched — see
 * {@link withStreamingIdleTimeout}).
 */
export function resolveStreamingIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[KIMCHI_STREAMING_IDLE_TIMEOUT_MS]
	if (raw !== undefined && raw !== "") {
		const parsed = Number.parseInt(raw, 10)
		if (Number.isInteger(parsed)) return parsed
	}
	return RETRY_DEFAULTS.provider.timeoutMs
}

/**
 * Wrap a model-completion `Response` body so that if the upstream delivers no
 * data for `idleMs`, the stream is errored.
 *
 * Why this exists: the OpenAI SDK's `fetchWithTimeout` clears its timer the
 * moment `fetch()` resolves — i.e. when response **headers** arrive — so the
 * configured `provider.timeoutMs` protects only the connection phase. The SSE
 * **body** phase is unprotected: if the gateway closes a socket mid-stream, no
 * data arrives and no error is thrown for 10–16 minutes, consuming the entire
 * per-task wall-clock budget on a single dead turn. This wrapper closes that
 * gap by re-arming a timer on every `pull`: a healthy stream that delivers
 * chunks continuously never trips it; only a completely idle socket does.
 *
 * The timer is reset on every chunk, so the threshold is an *inter-chunk idle*
 * window, not a total-stream deadline. `idleMs <= 0` disables the wrapper
 * (the response is returned unchanged).
 *
 * The error message contains "read timed out": the word "timeout" matches the upstream
 * `_isRetryableError` regex (so pi-ai retries the turn), and "timed out" matches
 * `classifyLLMGatewayError`'s `TRANSPORT_FAILURE_RE` (so the failure is classified as a
 * retryable `transport_failure`, same path as a real dead socket) — but reached in
 * ~`idleMs` instead of 10+ minutes.
 *
 * Composition: wrap the original body **innermost** (this function), then wrap
 * the result with the billing-refresh wrapper (outermost). The outer wrapper's
 * `reader.read()` rejects when this inner stream errors, so its catch path
 * still fires `refreshBilling()` on stream failure.
 */
export function withStreamingIdleTimeout(response: Response, idleMs: number): Response {
	const body = response.body
	if (!body || idleMs <= 0) return response

	const reader = body.getReader()
	// Active idle timer for the in-flight `reader.read()`. Stored on the
	// closure so `cancel()` can clear it if the consumer abandons the stream
	// before the next chunk arrives.
	let activeTimer: ReturnType<typeof setTimeout> | null = null
	// Set when the idle timer fires and errors the stream — guards the pending
	// `reader.read()` resolution so it doesn't touch the controller again.
	let errored = false
	// Set when the consumer cancels — guards both `pull`'s read resolution and
	// a (already-cleared) late timer from touching a closed controller.
	let cancelled = false

	const clearActiveTimer = (): void => {
		if (activeTimer !== null) {
			clearTimeout(activeTimer)
			activeTimer = null
		}
	}

	const wrappedBody = new ReadableStream<Uint8Array>({
		async pull(controller) {
			clearActiveTimer()
			activeTimer = setTimeout(() => {
				activeTimer = null
				if (cancelled || errored) return
				errored = true
				// Dead socket: no data for idleMs. Cancel the underlying reader
				// (releasing the pending `reader.read()`) and error the stream so
				// the OpenAI SDK throws, triggering retry / transport-failure
				// classification instead of hanging for 10+ minutes.
				reader.cancel("streaming idle timeout").catch(() => {})
				controller.error(
					new Error(`streaming idle timeout: no data for ${idleMs}ms (read timed out)`),
				)
			}, idleMs)
			try {
				const { done, value } = await reader.read()
				clearActiveTimer()
				if (errored || cancelled) return
				if (done) {
					controller.close()
					return
				}
				controller.enqueue(value)
			} catch (error) {
				clearActiveTimer()
				if (errored || cancelled) return
				controller.error(error)
			}
		},
		cancel(reason) {
			cancelled = true
			clearActiveTimer()
			return reader.cancel(reason)
		},
	})

	return new Response(wrappedBody, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	})
}
