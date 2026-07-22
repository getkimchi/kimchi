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
 * content continuously never trips it; only a content-starved socket does.
 *
 * The timer is **content-aware**: it resets only when a chunk contains a
 * non-comment SSE line (a `data:`, `event:`, `id:`, or `retry:` field). SSE
 * keep-alive comment lines (lines starting with `:`) do NOT reset the timer —
 * a stream that delivers only proxy keep-alive pings for `idleMs` is treated
 * as dead. The threshold is an *inter-content idle* window, not a total-stream
 * deadline. `idleMs <= 0` disables the wrapper (the response is returned
 * unchanged).
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
	// Tracks whether the most recently read chunk contained actual SSE content
	// (a non-comment line). When the last chunk was comment-only (a keep-alive
	// ping), the existing idle timer is left running across the next `pull` so
	// that a stream of only keep-alive pings does NOT reset the timer.
	let lastChunkHadContent = true
	// Closure-scoped line buffer for partial SSE lines spanning chunks. SSE
	// frames are newline-delimited; a chunk boundary may split a line, so we
	// hold the trailing partial line and prepend it to the next chunk.
	let sseLineBuffer = ""

	const clearActiveTimer = (): void => {
		if (activeTimer !== null) {
			clearTimeout(activeTimer)
			activeTimer = null
		}
	}

	/**
	 * Scan a chunk for non-comment SSE lines. Returns true if the chunk
	 * contains at least one complete line that does NOT start with ":"
	 * (i.e., actual SSE content — data/event/id/retry fields — not a
	 * keep-alive comment). Partial lines are buffered for the next call.
	 *
	 * SSE spec: lines starting with ":" are comments (keep-alive pings).
	 * All other field lines (data:, event:, id:, retry:) are content.
	 */
	function chunkHasSseContent(value: Uint8Array): boolean {
		sseLineBuffer += new TextDecoder().decode(value)
		// Split on LF, CRLF, or bare CR — all three are valid SSE line
		// terminators per the WHATWG spec. Splitting only on `\n` would leave a
		// trailing `\r` on each CRLF-terminated line; the bare `\r` (the
		// empty-line event terminator) has `length > 0` and does not start with
		// `:`, so it would be misclassified as content and silently defeat
		// keep-alive detection for any gateway/proxy that emits CRLF pings.
		const lines = sseLineBuffer.split(/\r\n|\r|\n/)
		// Last element is the incomplete line (or "" if chunk ends with \n).
		sseLineBuffer = lines.pop() ?? ""
		for (const line of lines) {
			if (line.length > 0 && !line.startsWith(":")) {
				return true
			}
		}
		return false
	}

	const wrappedBody = new ReadableStream<Uint8Array>({
		async pull(controller) {
			// Only (re-)arm the idle timer when the previous chunk carried real
			// SSE content. If the previous chunk was comment-only (a keep-alive
			// ping), the timer from that earlier pull continues running — comment
			// pings must NOT reset the idle window, otherwise a dead socket kept
			// alive by proxy pings hangs for the proxy's own timeout (10+ min).
			if (lastChunkHadContent) {
				clearActiveTimer()
				activeTimer = setTimeout(() => {
					activeTimer = null
					if (cancelled || errored) return
					errored = true
					// Dead socket: no content for idleMs. Cancel the underlying reader
					// (releasing the pending `reader.read()`) and error the stream so
					// the OpenAI SDK throws, triggering retry / transport-failure
					// classification instead of hanging for 10+ minutes.
					reader.cancel("streaming idle timeout").catch(() => {})
					controller.error(
						new Error(
							`streaming idle timeout: no content for ${idleMs}ms (read timed out)`,
						),
					)
				}, idleMs)
			}
			try {
				const { done, value } = await reader.read()
				if (errored || cancelled) return
				if (done) {
					clearActiveTimer()
					controller.close()
					return
				}
				lastChunkHadContent = chunkHasSseContent(value)
				if (lastChunkHadContent) {
					// Content arrived — the timer will be re-armed on the next pull.
					clearActiveTimer()
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
