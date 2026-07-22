import { describe, expect, it } from "vitest"
import { classifyLLMGatewayError } from "./llm-gateway-error.js"
import {
	KIMCHI_STREAMING_IDLE_TIMEOUT_MS,
	resolveStreamingIdleTimeoutMs,
	withStreamingIdleTimeout,
} from "./streaming-idle-timeout.js"

/**
 * Build a `Response` whose body stream never emits data — i.e. a dead socket
 * that has delivered headers but will never deliver an SSE chunk. The body's
 * `pull` is invoked but never calls `enqueue`/`close`, so `reader.read()` on it
 * hangs indefinitely (mirroring the real transport-failure shape: `out: 0`,
 * headers arrived, then silence).
 */
function deadSocketResponse(status = 200): Response {
	const body = new ReadableStream<Uint8Array>({
		pull() {
			// Intentionally never resolves: simulates a hung socket.
		},
	})
	return new Response(body, { status, statusText: "OK" })
}

/** Read every byte from a wrapped response body into a flat number array. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<number[]> {
	const out: number[] = []
	let res = await reader.read()
	while (!res.done) {
		for (const byte of res.value) out.push(byte)
		res = await reader.read()
	}
	return out
}

describe("withStreamingIdleTimeout", () => {
	describe("idle detection", () => {
		it("errors the stream when no data arrives within the idle threshold", async () => {
			const idleMs = 40
			const wrapped = withStreamingIdleTimeout(deadSocketResponse(), idleMs)
			const reader = wrapped.body!.getReader()

			await expect(reader.read()).rejects.toThrow(/streaming idle timeout: no data for 40ms.*read timed out/)
		})

		it("does not fire when data arrives within the threshold", async () => {
			const idleMs = 2000
			const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]
			const underlying = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk)
					controller.close()
				},
			})
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)

			const bytes = await drain(wrapped.body!.getReader())

			expect(bytes).toEqual([1, 2, 3, 4, 5, 6])
		})

		it("re-arms the timer per chunk so a slow-but-steady stream never trips it", async () => {
			// Each chunk arrives well within the idle window, but the stream's
			// total lifetime exceeds idleMs — proving the timer resets per pull.
			const idleMs = 60
			let emitted = 0
			const underlying = new ReadableStream<Uint8Array>({
				async pull(controller) {
					emitted++
					if (emitted > 3) {
						controller.close()
						return
					}
					await new Promise((r) => setTimeout(r, 20))
					controller.enqueue(new Uint8Array([emitted]))
				},
			})
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)

			const bytes = await drain(wrapped.body!.getReader())

			expect(bytes).toEqual([1, 2, 3])
		})

		it("re-arms the timer after an early chunk, then errors if the socket goes silent", async () => {
			// First chunk arrives immediately (timer cleared), then the socket
			// hangs — the per-pull timer must fire on the second, silent pull.
			const idleMs = 40
			let firstPull = true
			const underlying = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (firstPull) {
						firstPull = false
						controller.enqueue(new Uint8Array([42]))
						return
					}
					// Second pull: never resolves — dead socket mid-stream.
				},
			})
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			const first = await reader.read()
			if (first.done) throw new Error("expected the first chunk to arrive, not done")
			expect(Array.from(first.value)).toEqual([42])

			await expect(reader.read()).rejects.toThrow(/streaming idle timeout/)
		})
	})

	describe("composition with the billing-refresh wrapper", () => {
		// Mirrors the real `withBillingRefreshAfterResponseSettles` contract: an
		// outer reader does `await reader.read()` in a try/catch and runs its
		// refresh callback on stream completion OR error. The idle-timeout
		// wrapper sits innermost; this test asserts the outer wrapper still
		// observes the idle-timeout error and refreshes.
		function withRefreshSpy(
			response: Response,
			refresh: () => void,
		): Response {
			const body = response.body
			if (!body) {
				refresh()
				return response
			}
			const reader = body.getReader()
			let refreshed = false
			const refreshOnce = () => {
				if (refreshed) return
				refreshed = true
				refresh()
			}
			const wrappedBody = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const { done, value } = await reader.read()
						if (done) {
							controller.close()
							refreshOnce()
							return
						}
						controller.enqueue(value)
					} catch (error) {
						refreshOnce()
						controller.error(error)
					}
				},
				async cancel(reason) {
					try {
						await reader.cancel(reason)
					} finally {
						refreshOnce()
					}
				},
			})
			return new Response(wrappedBody, {
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			})
		}

		it("fires the outer refresh callback when the inner idle timeout errors the stream", async () => {
			const idleMs = 40
			let refreshCount = 0
			const inner = withStreamingIdleTimeout(deadSocketResponse(), idleMs)
			const composed = withRefreshSpy(inner, () => {
				refreshCount++
			})
			const reader = composed.body!.getReader()

			await expect(reader.read()).rejects.toThrow(/streaming idle timeout/)
			// Give the outer wrapper's catch path a microtask to settle.
			await new Promise((r) => setTimeout(r, 5))

			expect(refreshCount).toBe(1)
		})

		it("fires the outer refresh callback on normal completion of a healthy stream", async () => {
			const idleMs = 2000
			let refreshCount = 0
			const underlying = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]))
					controller.close()
				},
			})
			const inner = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const composed = withRefreshSpy(inner, () => {
				refreshCount++
			})

			await drain(composed.body!.getReader())

			expect(refreshCount).toBe(1)
		})
	})

	describe("cancel cleanup", () => {
		it("clears the idle timer on consumer cancel so no late idle-timeout error fires", async () => {
			const idleMs = 40
			let underlyingCancelled = false
			const underlying = new ReadableStream<Uint8Array>({
				pull() {
					// Hung socket.
				},
				cancel() {
					underlyingCancelled = true
				},
			})
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			// Kick off a read so `pull` arms the idle timer.
			const readPromise = reader.read()
			// Cancel before the timer fires.
			await reader.cancel("consumer cancelled")
			// The pending read resolves/rejects with the cancel outcome — never
			// the idle-timeout error.
			await readPromise.catch(() => {})
			expect(underlyingCancelled).toBe(true)

			// Wait well past the idle window. If the timer were not cleared,
			// `controller.error()` would throw on the closed stream here (the
			// implementation guards against this; this assertion pins the guard).
			await new Promise((r) => setTimeout(r, idleMs + 60))
		})
	})

	describe("error classification", () => {
		it("produces a message that classifies as a retryable transport_failure", () => {
			const message = `streaming idle timeout: no data for 120000ms (read timed out)`
			const verdict = classifyLLMGatewayError(message)

			expect(verdict?.reason).toBe("transport_failure")
			expect(verdict?.retryable).toBe(true)
			expect(verdict?.isInfrastructure).toBe(true)
		})
	})

	describe("edge cases", () => {
		it("returns the response untouched when idleMs <= 0 (wrapper disabled)", async () => {
			const underlying = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([7]))
					controller.close()
				},
			})
			const original = new Response(underlying, { status: 200 })

			const wrapped = withStreamingIdleTimeout(original, 0)

			// Same body instance — no wrapper installed.
			expect(wrapped.body).toBe(original.body)
			expect(await drain(wrapped.body!.getReader())).toEqual([7])
		})

		it("returns the response untouched when the body is null", () => {
			const original = new Response(null, { status: 204 })

			const wrapped = withStreamingIdleTimeout(original, 40)

			expect(wrapped).toBe(original)
		})

		it("propagates the underlying stream's error unchanged when the socket errors before the idle window", async () => {
			const idleMs = 5000
			const underlying = new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.error(new Error("upstream socket hang up"))
				},
			})
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			await expect(reader.read()).rejects.toThrow("upstream socket hang up")
		})
	})
})

describe("resolveStreamingIdleTimeoutMs", () => {
	it("defaults to RETRY_DEFAULTS.provider.timeoutMs", () => {
		expect(resolveStreamingIdleTimeoutMs({})).toBe(120_000)
	})

	it("honours the KIMCHI_STREAMING_IDLE_TIMEOUT_MS override when it is a positive integer", () => {
		expect(
			resolveStreamingIdleTimeoutMs({
				[KIMCHI_STREAMING_IDLE_TIMEOUT_MS]: "5000",
			}),
		).toBe(5000)
	})

	it("falls back to the default when the override is not an integer", () => {
		expect(
			resolveStreamingIdleTimeoutMs({
				[KIMCHI_STREAMING_IDLE_TIMEOUT_MS]: "not-a-number",
			}),
		).toBe(120_000)
	})

	it("allows a non-positive override to effectively disable the wrapper", () => {
		expect(
			resolveStreamingIdleTimeoutMs({
				[KIMCHI_STREAMING_IDLE_TIMEOUT_MS]: "0",
			}),
		).toBe(0)
	})
})
