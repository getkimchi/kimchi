const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 524])
// Default retry budget for kimchi backend calls when the caller passes no retry
// option. Deliberately independent of config's RETRY_DEFAULTS, which seeds
// pi's chat retry policy — a different concern with a much smaller budget.
const DEFAULT_MAX_RETRIES = 10
const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 60_000
const BACKOFF_FACTOR = 2

export interface FetchWithRetryOptions {
	timeoutMs?: number
	retry?: { maxRetries?: number }
	signal?: AbortSignal
	fetchImpl?: typeof globalThis.fetch
}

/**
 * Exponential backoff with full jitter.
 * delay = min(BASE * FACTOR^(attempt-1), MAX) * random()
 * Floor of 100ms to avoid busy-loops.
 */
export function computeRetryDelayMs(attempt: number, random: () => number = Math.random): number {
	const planned = Math.min(BASE_DELAY_MS * BACKOFF_FACTOR ** (attempt - 1), MAX_DELAY_MS)
	return Math.max(planned * random(), 100)
}

function isRetryableResponse(response: Response): boolean {
	return RETRYABLE_STATUSES.has(response.status)
}

function parseRetryAfterMs(response: Response): number | null {
	const header = response.headers.get("retry-after")
	if (!header) return null
	const seconds = Number(header)
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
	const dateMs = Date.parse(header)
	if (!Number.isNaN(dateMs)) return Math.max(dateMs - Date.now(), 0)
	return null
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason)
			return
		}
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer)
				reject(signal.reason)
			},
			{ once: true },
		)
	})
}

export async function fetchWithRetry(
	url: string,
	init?: RequestInit,
	options?: FetchWithRetryOptions,
): Promise<Response> {
	const fetchFn = options?.fetchImpl ?? globalThis.fetch
	const timeoutMs = options?.timeoutMs ?? 30_000
	// maxRetries is the number of retries after the initial attempt, so the
	// total attempt budget is maxRetries + 1. Negative values are treated as 0.
	const maxRetries = Math.max(options?.retry?.maxRetries ?? DEFAULT_MAX_RETRIES, 0)
	const maxAttempts = maxRetries + 1

	let lastError: unknown

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const ctrl = new AbortController()
		const timer = setTimeout(() => ctrl.abort(), timeoutMs)
		const signal = options?.signal ? AbortSignal.any([ctrl.signal, options.signal]) : ctrl.signal

		try {
			const response = await fetchFn(url, { ...init, signal })
			clearTimeout(timer)

			if (!isRetryableResponse(response) || attempt === maxAttempts) {
				return response
			}

			// Drain body so the connection can be reused
			await response.body?.cancel().catch(() => {})

			lastError = new Error(`HTTP ${response.status}`)

			const retryAfterMs = parseRetryAfterMs(response)
			const computedDelay = computeRetryDelayMs(attempt)
			const delay = retryAfterMs !== null ? Math.max(computedDelay, retryAfterMs) : computedDelay
			await abortableDelay(delay, options?.signal)
		} catch (error) {
			clearTimeout(timer)

			// If caller aborted, don't retry
			if (options?.signal?.aborted) throw error

			if (attempt === maxAttempts) throw error

			lastError = error

			const delay = computeRetryDelayMs(attempt)
			await abortableDelay(delay, options?.signal)
		}
	}

	throw lastError
}
