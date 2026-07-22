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

const textEncoder = new TextEncoder()
/** Encode a string to a `Uint8Array` (SSE chunks in tests are text). */
const encode = (s: string): Uint8Array => textEncoder.encode(s)
/** An SSE `data:` content chunk (model output token). */
const dataChunk = (s = "data: {\"token\":\"x\"}\n\n"): Uint8Array => encode(s)
/** An SSE keep-alive comment chunk (`:`-prefixed line per the SSE spec). */
const pingChunk = (s = ": ping\n\n"): Uint8Array => encode(s)

describe("withStreamingIdleTimeout", () => {
	describe("idle detection", () => {
		it("errors the stream when no data arrives within the idle threshold", async () => {
			const idleMs = 40
			const wrapped = withStreamingIdleTimeout(deadSocketResponse(), idleMs)
			const reader = wrapped.body!.getReader()

			await expect(reader.read()).rejects.toThrow(/streaming idle timeout: no content for 40ms.*read timed out/)
		})

		it("does not fire when content arrives within the threshold", async () => {
			const idleMs = 2000
			const chunks = [dataChunk(), dataChunk()]
			const underlying = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const chunk of chunks) controller.enqueue(chunk)
					controller.close()
				},
			})
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)

			const bytes = await drain(wrapped.body!.getReader())

			// Both content chunks are drained unchanged.
			expect(bytes).toEqual([...dataChunk(), ...dataChunk()])
		})

		it("re-arms the timer per content chunk so a slow-but-steady stream never trips it", async () => {
			// Each content chunk arrives well within the idle window, but the
			// stream's total lifetime exceeds idleMs — proving the timer resets
			// on every content chunk.
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
					controller.enqueue(dataChunk())
				},
			})
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)

			const bytes = await drain(wrapped.body!.getReader())

			expect(bytes).toEqual([...dataChunk(), ...dataChunk(), ...dataChunk()])
		})

		it("re-arms the timer after an early content chunk, then errors if the socket goes silent", async () => {
			// First chunk is content (timer cleared), then the socket hangs —
			// the per-pull timer must fire on the second, silent pull.
			const idleMs = 40
			let firstPull = true
			const underlying = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (firstPull) {
						firstPull = false
						controller.enqueue(dataChunk())
						return
					}
					// Second pull: never resolves — dead socket mid-stream.
				},
			})
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			const first = await reader.read()
			if (first.done) throw new Error("expected the first chunk to arrive, not done")
			expect(Array.from(first.value)).toEqual(Array.from(dataChunk()))

			await expect(reader.read()).rejects.toThrow(/streaming idle timeout/)
		})
	})

	describe("keep-alive comment pings", () => {
		/** Build a stream that emits the given chunks with `delayMs` between each. */
		function timedStream(chunks: Uint8Array[], delayMs: number): ReadableStream<Uint8Array> {
			let i = 0
			return new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (i >= chunks.length) {
						controller.close()
						return
					}
					await new Promise((r) => setTimeout(r, delayMs))
					controller.enqueue(chunks[i++])
				},
			})
		}

		it("keep-alive-only chunks do NOT reset the timer; the timer fires after idleMs", async () => {
			// Pings arrive every 15ms (well within the 50ms idle window), but
			// they are comment lines — the content-aware timer must NOT reset
			// on them and must fire after idleMs of pings.
			const idleMs = 50
			const underlying = new ReadableStream<Uint8Array>({
				async pull(controller) {
					await new Promise((r) => setTimeout(r, 15))
					controller.enqueue(pingChunk())
				},
			})
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			// Drain pings until the idle timer fires and errors the stream.
			// At least one ping must arrive (proving comment chunks are enqueued
			// but do NOT reset the timer), then the stream must error within
			// ~idleMs + a couple of ping intervals — NOT hang for the proxy's
			// own connection timeout.
			let sawPing = false
			let lastError: unknown = null
			try {
				for (;;) {
					const res = await reader.read()
					if (res.done) break
					sawPing = true
				}
			} catch (e) {
				lastError = e
			}

			expect(sawPing).toBe(true)
			expect(lastError).toBeInstanceOf(Error)
			expect(String(lastError)).toMatch(/streaming idle timeout: no content for 50ms/)
		})

		it("a content chunk resets the timer so a stream with content never trips", async () => {
			const idleMs = 60
			// Content arrives at 20ms intervals — well within the idle window.
			const underlying = timedStream([dataChunk(), dataChunk()], 20)
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			const a = await reader.read()
			expect(a.done).toBe(false)
			const b = await reader.read()
			expect(b.done).toBe(false)
			const c = await reader.read()
			expect(c.done).toBe(true)
		})

		it("mixed comment + content chunk resets the timer", async () => {
			const idleMs = 60
			// A chunk with both a comment and a data line is content.
			const mixed = encode(": ping\n\ndata: {\"x\":1}\n\n")
			const underlying = timedStream([mixed, mixed], 20)
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			const a = await reader.read()
			expect(a.done).toBe(false)
			const b = await reader.read()
			expect(b.done).toBe(false)
			const c = await reader.read()
			expect(c.done).toBe(true)
		})

		it("a content chunk after pings resets the timer and clears the running idle window", async () => {
			// Pings arrive at 20ms intervals, then content arrives at 50ms (still
			// within idleMs=120). The content resets the timer; the stream then
			// closes normally.
			const idleMs = 120
			const underlying = timedStream([pingChunk(), pingChunk(), dataChunk()], 20)
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			const chunks: Uint8Array[] = []
			let res = await reader.read()
			while (!res.done) {
				chunks.push(res.value)
				res = await reader.read()
			}
			expect(chunks.length).toBe(3)
		})

		it("handles a data: line split across two chunks", async () => {
			// Chunk 1 ends mid-line ("dat"), chunk 2 completes it ("a: {}\n\n").
			// Neither chunk alone contains a complete non-comment line — the
			// line buffer holds "dat" across the boundary and the completed line
			// is detected on the second chunk.
			const idleMs = 60
			const part1 = encode(": ping\n\ndat")
			const part2 = encode("a: {}\n\n")
			const underlying = timedStream([part1, part2], 20)
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			const a = await reader.read()
			expect(a.done).toBe(false)
			const b = await reader.read()
			expect(b.done).toBe(false)
			const c = await reader.read()
			expect(c.done).toBe(true)
		})

		it("keep-alive pings with CRLF line endings do NOT reset the timer", async () => {
			// CRLF-terminated keep-alive pings (`: ping\r\n\r\n`) are valid per
			// the SSE spec and common from HTTP/proxy servers. Splitting only on
			// `\n` would leave a bare `\r` event terminator that is
			// misclassified as content — silently defeating keep-alive detection.
			const idleMs = 50
			const underlying = new ReadableStream<Uint8Array>({
				async pull(controller) {
					await new Promise((r) => setTimeout(r, 15))
					controller.enqueue(pingChunk(": ping\r\n\r\n"))
				},
			})
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			let sawPing = false
			let lastError: unknown = null
			try {
				for (;;) {
					const res = await reader.read()
					if (res.done) break
					sawPing = true
				}
			} catch (e) {
				lastError = e
			}

			expect(sawPing).toBe(true)
			expect(lastError).toBeInstanceOf(Error)
			expect(String(lastError)).toMatch(/streaming idle timeout: no content for 50ms/)
		})

		it("mixed CRLF keep-alive + LF content chunk resets the timer", async () => {
			// A chunk with a CRLF keep-alive comment followed by an LF-terminated
			// content line is content — the content line resets the timer.
			const idleMs = 60
			const mixed = encode(": ping\r\n\r\ndata: {\"x\":1}\n\n")
			const underlying = timedStream([mixed, mixed], 20)
			const wrapped = withStreamingIdleTimeout(new Response(underlying, { status: 200 }), idleMs)
			const reader = wrapped.body!.getReader()

			const a = await reader.read()
			expect(a.done).toBe(false)
			const b = await reader.read()
			expect(b.done).toBe(false)
			const c = await reader.read()
			expect(c.done).toBe(true)
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
			const message = `streaming idle timeout: no content for 120000ms (read timed out)`
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
