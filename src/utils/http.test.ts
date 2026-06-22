import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computeRetryDelayMs, fetchWithRetry } from "./http.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(status: number, headers?: Record<string, string>): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: {
			get: (name: string) => headers?.[name.toLowerCase()] ?? null,
		},
	} as unknown as Response
}

// ---------------------------------------------------------------------------
// computeRetryDelayMs
// ---------------------------------------------------------------------------

describe("computeRetryDelayMs", () => {
	it("returns expected delays for attempts 1-5 with random=()=>1", () => {
		const random = () => 1

		// planned = min(1000 * 2^(attempt-1), 60000), floor 100
		// attempt 1: min(1000, 60000) * 1 = 1000
		expect(computeRetryDelayMs(1, random)).toBe(1_000)
		// attempt 2: min(2000, 60000) * 1 = 2000
		expect(computeRetryDelayMs(2, random)).toBe(2_000)
		// attempt 3: min(4000, 60000) * 1 = 4000
		expect(computeRetryDelayMs(3, random)).toBe(4_000)
		// attempt 4: min(8000, 60000) * 1 = 8000
		expect(computeRetryDelayMs(4, random)).toBe(8_000)
		// attempt 5: min(16000, 60000) * 1 = 16000
		expect(computeRetryDelayMs(5, random)).toBe(16_000)
	})

	it("caps at MAX_DELAY_MS (60s) for high attempt numbers", () => {
		const random = () => 1

		// attempt 7: 1000 * 2^6 = 64000, capped to 60000
		expect(computeRetryDelayMs(7, random)).toBe(60_000)
		// attempt 20: well beyond cap
		expect(computeRetryDelayMs(20, random)).toBe(60_000)
	})

	it("returns floor of 100ms when random=()=>0", () => {
		const random = () => 0

		// planned * 0 = 0, max(0, 100) = 100
		expect(computeRetryDelayMs(1, random)).toBe(100)
		expect(computeRetryDelayMs(5, random)).toBe(100)
	})

	it("returns half the planned delay when random=()=>0.5", () => {
		const random = () => 0.5

		// attempt 1: 1000 * 0.5 = 500
		expect(computeRetryDelayMs(1, random)).toBe(500)
		// attempt 2: 2000 * 0.5 = 1000
		expect(computeRetryDelayMs(2, random)).toBe(1_000)
		// attempt 3: 4000 * 0.5 = 2000
		expect(computeRetryDelayMs(3, random)).toBe(2_000)
	})
})

// ---------------------------------------------------------------------------
// fetchWithRetry
// ---------------------------------------------------------------------------

describe("fetchWithRetry", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	// Advance all pending timers so delays in fetchWithRetry resolve quickly.
	// We wrap each test that needs retries with a helper that races the
	// promise against timer advancement.
	async function runWithTimers<T>(fn: () => Promise<T>): Promise<T> {
		const promise = fn()
		// Keep advancing until the promise settles.
		await vi.runAllTimersAsync()
		return promise
	}

	// -------------------------------------------------------------------------
	// Happy path
	// -------------------------------------------------------------------------

	it("returns a successful response without retrying", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200))

		const response = await fetchWithRetry("https://example.com", undefined, { fetchImpl })

		expect(response.status).toBe(200)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	// -------------------------------------------------------------------------
	// Retry on transient HTTP status codes
	// -------------------------------------------------------------------------

	it.each([429, 500, 502, 503, 504, 524])("retries on %i and returns the successful response", async (status) => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(makeResponse(status)).mockResolvedValueOnce(makeResponse(200))

		const response = await runWithTimers(() =>
			fetchWithRetry("https://example.com", undefined, {
				fetchImpl,
				retry: { maxRetries: 3 },
			}),
		)

		expect(response.status).toBe(200)
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	// -------------------------------------------------------------------------
	// Retry on network error
	// -------------------------------------------------------------------------

	it("retries after a network TypeError and returns the successful response", async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce(makeResponse(200))

		const response = await runWithTimers(() =>
			fetchWithRetry("https://example.com", undefined, {
				fetchImpl,
				retry: { maxRetries: 3 },
			}),
		)

		expect(response.status).toBe(200)
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	// -------------------------------------------------------------------------
	// Respects maxRetries - returns final bad response
	// -------------------------------------------------------------------------

	it("calls fetch exactly maxRetries times and returns the final bad response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(makeResponse(500))

		const response = await runWithTimers(() =>
			fetchWithRetry("https://example.com", undefined, {
				fetchImpl,
				retry: { maxRetries: 3 },
			}),
		)

		// Last attempt is returned, not thrown
		expect(response.status).toBe(500)
		expect(fetchImpl).toHaveBeenCalledTimes(3)
	})

	// -------------------------------------------------------------------------
	// Throws after all retries exhausted on network error
	// -------------------------------------------------------------------------

	it("throws after exhausting retries when fetch always throws", async () => {
		const networkError = new TypeError("fetch failed")
		const fetchImpl = vi.fn().mockRejectedValue(networkError)

		// Attach a no-op rejection handler immediately so the promise is never
		// "unhandled" while timers are being flushed.
		const promise = fetchWithRetry("https://example.com", undefined, {
			fetchImpl,
			retry: { maxRetries: 2 },
		})
		promise.catch(() => {})

		await vi.runAllTimersAsync()

		await expect(promise).rejects.toThrow("fetch failed")
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	// -------------------------------------------------------------------------
	// Respects caller abort signal
	// -------------------------------------------------------------------------

	it("throws immediately without retrying when caller signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()

		const fetchImpl = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"))

		await expect(
			fetchWithRetry("https://example.com", undefined, {
				fetchImpl,
				signal: controller.signal,
				retry: { maxRetries: 5 },
			}),
		).rejects.toThrow()

		// Should not retry after caller aborts
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it("aborts during retry delay when signal is triggered", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(makeResponse(500)).mockResolvedValueOnce(makeResponse(200))
		const controller = new AbortController()

		const promise = fetchWithRetry("https://example.com", undefined, {
			fetchImpl,
			signal: controller.signal,
			retry: { maxRetries: 3 },
		})

		// Let the first attempt complete and enter retry delay
		await vi.advanceTimersByTimeAsync(0)
		// Abort during the delay
		controller.abort()

		await expect(promise).rejects.toThrow()
		// Should NOT have made a second attempt
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	// -------------------------------------------------------------------------
	// Timeout via AbortController
	// -------------------------------------------------------------------------

	it("aborts and throws when fetch hangs past timeoutMs", async () => {
		const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
			// Simulate a hanging fetch that respects the abort signal
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					reject(new DOMException("The operation was aborted.", "AbortError"))
				})
			})
		})

		const promise = fetchWithRetry("https://example.com", undefined, {
			fetchImpl,
			timeoutMs: 100,
			retry: { maxRetries: 1 },
		})
		// Suppress unhandled rejection during timer flush
		promise.catch(() => {})

		// Advance past the timeout
		await vi.advanceTimersByTimeAsync(200)

		await expect(promise).rejects.toThrow()
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	// -------------------------------------------------------------------------
	// Retry-After header
	// -------------------------------------------------------------------------

	it("waits at least Retry-After seconds before retrying on 429", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(makeResponse(429, { "retry-after": "2" }))
			.mockResolvedValueOnce(makeResponse(200))

		let settled = false
		const promise = fetchWithRetry("https://example.com", undefined, {
			fetchImpl,
			retry: { maxRetries: 3 },
		}).then((r) => {
			settled = true
			return r
		})

		// Advance less than 2s — should not have settled yet (still waiting for Retry-After)
		await vi.advanceTimersByTimeAsync(1_500)
		expect(settled).toBe(false)

		// Advance past the 2s Retry-After window
		await vi.advanceTimersByTimeAsync(1_000)
		const response = await promise

		expect(response.status).toBe(200)
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	// -------------------------------------------------------------------------
	// Does not retry non-retriable 4xx
	// -------------------------------------------------------------------------

	it.each([400, 401, 403, 404])("does not retry %i and returns the response after a single call", async (status) => {
		const fetchImpl = vi.fn().mockResolvedValue(makeResponse(status))

		const response = await fetchWithRetry("https://example.com", undefined, {
			fetchImpl,
			retry: { maxRetries: 5 },
		})

		expect(response.status).toBe(status)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})
})
