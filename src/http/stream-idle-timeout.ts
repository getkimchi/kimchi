/**
 * HTTP idle timeout for all outbound fetch traffic.
 *
 * Background: kimchi ships as a Bun-compiled binary, and under Bun the undici
 * dispatcher timeouts pi-mono relies on (`configureHttpDispatcher`'s
 * bodyTimeout/headersTimeout) are inert — Bun aliases the "undici" module to a
 * builtin shim whose dispatcher options its native fetch never consults, and
 * npm undici's client cannot run under Bun at all (oven-sh/bun#19748, #21944).
 * A silently dead socket therefore has no client-side deadline: the request
 * hangs until the OS TCP stack gives up (~11 min observed in CI benchmark
 * runs), burning the trial's time budget before any retry fires.
 *
 * This wrapper is the runtime-agnostic replacement: an *idle* timeout, not a
 * total-request timeout. The clock only advances while the consumer is waiting
 * for bytes and none arrive — the wait for response headers and every body
 * read are each bounded, and every delivered chunk resets the clock. A
 * slow-but-alive stream (tokens/keepalives trickling) never trips it; a dead
 * socket trips it after `idleMs`.
 *
 * Coverage and configuration mirror pi-mono's undici mechanism: every request
 * through the patched global fetch is subject to the timeout (matching what
 * undici's dispatcher enforces for pi under Node), and the deadline comes from
 * pi's `httpIdleTimeoutMs` setting — 300s default, `0`/"disabled" opts out.
 *
 * When it fires, the surfaced error message intentionally contains "socket
 * connection closed" and "timed out" so that `classifyLLMGatewayError`
 * (src/llm-gateway-error.ts) tags it `transport_failure` — retryable +
 * infrastructure — and it flows through the exact same retry + circuit-breaker
 * path as a real socket closure, just at the configured deadline instead of
 * ~11 min.
 */

import { getSettingsManager } from "../settings-watcher.js"
import { getStreamIdleTimeoutOverride } from "./idle-timeout-override.js"

// Re-exported for tests and callers that already reach this module; production
// setters (proxy.ts) import the slot module directly — see the note there about
// entry.ts import order.
export { setStreamIdleTimeoutOverride } from "./idle-timeout-override.js"

export const STREAM_IDLE_TIMEOUT_ENV = "KIMCHI_STREAM_IDLE_TIMEOUT_MS"

/**
 * Fallback when no setting is readable: pi-mono's DEFAULT_HTTP_IDLE_TIMEOUT_MS
 * (not re-exported by the package).
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/**
 * Resolve the idle timeout: env var → session override → pi's
 * `httpIdleTimeoutMs` setting → pi's default. `0` disables the timeout at
 * every level. Resolved per request (not at wrap time) so a settings change
 * applies to the next request without a restart — the settings-watcher cache
 * is invalidated on file writes, which pi's /settings UI performs after every
 * change.
 */
export function resolveStreamIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[STREAM_IDLE_TIMEOUT_ENV]
	if (raw !== undefined && raw.trim() !== "") {
		// Number(), not parseInt(): parseInt silently truncates at the first
		// non-digit, so a unit-suffixed value like "300s" would become a 300ms
		// timeout that kills every request. Malformed values fall through to
		// the next resolution level instead.
		const parsed = Number(raw.trim())
		if (Number.isInteger(parsed) && parsed >= 0) return parsed
	}
	const override = getStreamIdleTimeoutOverride()
	if (override !== undefined) return override
	try {
		return getSettingsManager()?.getHttpIdleTimeoutMs() ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
	} catch {
		return DEFAULT_STREAM_IDLE_TIMEOUT_MS
	}
}

/** Error thrown when a request/stream receives no bytes within the idle window. */
export class StreamIdleTimeoutError extends Error {
	readonly name = "StreamIdleTimeoutError"
	readonly idleMs: number
	constructor(idleMs: number, host: string, phase: "headers" | "body") {
		// Phrasing is load-bearing: "socket connection closed" + "read timed out"
		// both match TRANSPORT_FAILURE_RE in classifyLLMGatewayError, so the
		// existing retry/breaker machinery treats this exactly like a real socket
		// closure. Do not soften without updating that classifier + its tests.
		super(
			`Stream idle timeout: socket connection closed — no bytes received from ${host} ` +
				`during ${phase} for ${idleMs}ms (read timed out)`,
		)
		this.idleMs = idleMs
	}
}

export function requestUrl(input: RequestInfo | URL): string | undefined {
	if (typeof input === "string") return input
	if (input instanceof URL) return input.toString()
	if (typeof (input as Request).url === "string") return (input as Request).url
	return undefined
}

function hostOf(input: RequestInfo | URL): string {
	const url = requestUrl(input)
	if (!url) return "provider"
	try {
		return new URL(url).host
	} catch {
		return "provider"
	}
}

/** Sentinel resolved by the idle branch of the per-pull race. */
const IDLE = Symbol("idle")

/**
 * Wrap `response.body` so that a pull which waits longer than `idleMs` for a
 * chunk aborts the underlying request and errors the stream with a
 * transport-classified error — never a silent close, so downstream SSE
 * consumers see a real, classifiable failure instead of a truncated-but-clean
 * end. Resets on every delivered chunk. `onSettled` fires once the stream
 * reaches any terminal state (close, error, or cancel) so per-request
 * resources — like the abort-bridge listener on a caller-supplied signal —
 * can be released.
 */
function wrapBodyWithIdleTimeout(
	source: ReadableStream<Uint8Array>,
	idleMs: number,
	host: string,
	abort: (error: unknown) => void,
	onSettled: () => void,
): ReadableStream<Uint8Array> {
	const reader = source.getReader()
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			let timer: ReturnType<typeof setTimeout> | undefined
			// The idle branch *resolves* (never rejects) with a sentinel so the
			// losing branch of Promise.race can never dangle as an unhandled
			// rejection. The read promise is likewise given a no-op catch: if idle
			// wins we abandon it, and cancelling the reader will reject it.
			const idle = new Promise<typeof IDLE>((resolve) => {
				timer = setTimeout(() => resolve(IDLE), idleMs)
			})
			const read = reader.read()
			read.catch(() => {})
			try {
				const result = await Promise.race([read, idle])
				if (result === IDLE) {
					// Tear the socket down so it does not linger for the OS TCP
					// timeout, then surface our transport-classified error.
					const error = new StreamIdleTimeoutError(idleMs, host, "body")
					abort(error)
					await reader.cancel(error).catch(() => {})
					controller.error(error)
					onSettled()
					return
				}
				if (result.done) {
					controller.close()
					onSettled()
					return
				}
				controller.enqueue(result.value)
			} catch (error) {
				abort(error)
				await reader.cancel(error).catch(() => {})
				controller.error(error)
				onSettled()
			} finally {
				if (timer !== undefined) clearTimeout(timer)
			}
		},
		cancel(reason) {
			abort(reason)
			onSettled()
			return reader.cancel(reason)
		},
	})
}

/**
 * Rebuild a Response around a replacement body, preserving the metadata the
 * Response constructor cannot set: url/redirected come from the network layer,
 * so a plain rebuild reports url:"" — delegate to the original for consumers
 * that read them (redirect checks, logging). Shared with the billing-refresh
 * wrapper in instrument-fetch.ts so both layers rewrap consistently.
 */
export function rewrapResponseWithBody(original: Response, body: ReadableStream<Uint8Array>): Response {
	const wrapped = new Response(body, {
		status: original.status,
		statusText: original.statusText,
		headers: original.headers,
	})
	Object.defineProperties(wrapped, {
		url: { get: () => original.url },
		redirected: { get: () => original.redirected },
	})
	return wrapped
}

/**
 * Return a fetch that enforces the idle timeout on every request. The timeout
 * is resolved per request; `0` ("disabled") makes that request a pass-through.
 * The timeout covers both the wait for response headers and each subsequent
 * body read.
 */
export function wrapFetchWithIdleTimeout(originalFetch: FetchFn): FetchFn {
	return async function fetchWithIdleTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const idleMs = resolveStreamIdleTimeoutMs()
		if (idleMs <= 0) return originalFetch(input, init)

		const host = hostOf(input)
		const controller = new AbortController()
		let idleError: StreamIdleTimeoutError | undefined

		// Bridge any caller-supplied signal into our controller so external
		// cancellation still works. The signal can arrive via init OR carried
		// on a Request-object input — we always pass our own init.signal below,
		// which per spec supersedes the Request's signal, so failing to bridge
		// the Request's signal would silently disconnect caller aborts.
		const userSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
		// The bridge listener must be removed once the request settles: on a
		// long-lived shared signal (one session AbortSignal reused across many
		// requests) an un-removed {once:true} listener leaks a closure per
		// request until the signal fires.
		let removeAbortBridge: (() => void) | undefined
		if (userSignal) {
			if (userSignal.aborted) controller.abort(userSignal.reason)
			else {
				const onUserAbort = () => controller.abort(userSignal.reason)
				userSignal.addEventListener("abort", onUserAbort, { once: true })
				removeAbortBridge = () => userSignal.removeEventListener("abort", onUserAbort)
			}
		}

		// Headers phase: abort if no response headers arrive within idleMs.
		const headersTimer = setTimeout(() => {
			idleError = new StreamIdleTimeoutError(idleMs, host, "headers")
			controller.abort(idleError)
		}, idleMs)

		let response: Response
		try {
			response = await originalFetch(input, { ...init, signal: controller.signal })
		} catch (error) {
			removeAbortBridge?.()
			if (idleError) throw idleError
			throw error
		} finally {
			clearTimeout(headersTimer)
		}

		// No body to monitor (e.g. 204) — hand the response back untouched.
		if (!response.body) {
			removeAbortBridge?.()
			return response
		}

		const wrappedBody = wrapBodyWithIdleTimeout(
			response.body,
			idleMs,
			host,
			(error) => {
				controller.abort(error)
			},
			() => removeAbortBridge?.(),
		)

		return rewrapResponseWithBody(response, wrappedBody)
	}
}
