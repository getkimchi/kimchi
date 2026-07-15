import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	createInferenceTimeoutFetch,
	InferenceTimeoutError,
	resolveInferenceTimeoutMs,
} from "./inference-timeout.js"

const completionUrl = "https://llm.example/openai/v1/chat/completions"

function requestInit(model = "minimax-m3", messages: unknown[] = []): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model, messages, stream: true }),
	}
}

describe("inference timeout fetch", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("times out while waiting for response headers", async () => {
		const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
			})
		}) as unknown as typeof fetch
		const onTimeout = vi.fn()
		const timedFetch = createInferenceTimeoutFetch({
			fetchImpl,
			settings: { defaultMs: 100, overrides: {} },
			onTimeout,
		})

		const response = timedFetch(completionUrl, requestInit())
		const rejection = expect(response).rejects.toBeInstanceOf(InferenceTimeoutError)
		await vi.advanceTimersByTimeAsync(100)

		await rejection
		expect(onTimeout).toHaveBeenCalledWith(
			expect.objectContaining({ type: "inference_timeout", model: "minimax-m3", timeoutMs: 100 }),
		)
	})

	it("times out a post-header stream even while keepalives arrive", async () => {
		let sourceController: ReadableStreamDefaultController<Uint8Array>
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				sourceController = controller
			},
		})
		const fetchImpl = vi.fn(async () => new Response(source)) as unknown as typeof fetch
		const onTimeout = vi.fn()
		const timedFetch = createInferenceTimeoutFetch({
			fetchImpl,
			settings: { defaultMs: 100, overrides: { "minimax/minimax-m3": 50 } },
			resolveProvider: () => "minimax",
			onTimeout,
		})

		const response = await timedFetch(
			completionUrl,
			requestInit("minimax-m3", [{ role: "tool", content: "result" }]),
		)
		const reader = response.body?.getReader()
		const pendingRead = reader?.read()
		sourceController.enqueue(new TextEncoder().encode(": keepalive\n\n"))
		await expect(pendingRead).resolves.toEqual(expect.objectContaining({ done: false }))
		const timedOutRead = reader?.read()
		const rejection = expect(timedOutRead).rejects.toThrow("inference_timeout")
		await vi.advanceTimersByTimeAsync(50)

		await rejection
		expect(onTimeout).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "minimax",
				model: "minimax-m3",
				postToolResult: true,
				timeoutMs: 50,
			}),
		)
	})

	it("allows a healthy streamed response to finish under its deadline and cleans up once", async () => {
		const onTimeout = vi.fn()
		const onResponseSettled = vi.fn()
		const timedFetch = createInferenceTimeoutFetch({
			fetchImpl: vi.fn(async () => new Response("data: ok\n\ndata: [DONE]\n\n")) as unknown as typeof fetch,
			settings: { defaultMs: 1_000, overrides: {} },
			onTimeout,
			onResponseSettled,
		})

		const response = await timedFetch(completionUrl, requestInit())
		await vi.advanceTimersByTimeAsync(900)
		await expect(response.text()).resolves.toContain("[DONE]")
		await vi.advanceTimersByTimeAsync(1_000)

		expect(onTimeout).not.toHaveBeenCalled()
		expect(onResponseSettled).toHaveBeenCalledTimes(1)
	})

	it("preserves caller cancellation instead of converting it to inference_timeout", async () => {
		const caller = new AbortController()
		const callerError = new Error("cancelled by user")
		const onTimeout = vi.fn()
		const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				if (init?.signal?.aborted) {
					reject(init.signal.reason)
					return
				}
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
			})
		}) as unknown as typeof fetch
		const timedFetch = createInferenceTimeoutFetch({
			fetchImpl,
			settings: { defaultMs: 100, overrides: {} },
			onTimeout,
		})

		const response = timedFetch(completionUrl, { ...requestInit(), signal: caller.signal })
		caller.abort(callerError)

		await expect(response).rejects.toBe(callerError)
		expect(onTimeout).not.toHaveBeenCalled()
	})

	it("passes non-completion requests through without a deadline", async () => {
		const response = new Response("ok")
		const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch
		const timedFetch = createInferenceTimeoutFetch({
			fetchImpl,
			settings: { defaultMs: 1, overrides: {} },
		})

		await expect(timedFetch("https://example.com/models")).resolves.toBe(response)
		await vi.advanceTimersByTimeAsync(10)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})
})

describe("resolveInferenceTimeoutMs", () => {
	it("prefers provider/model, then model, then the global default", () => {
		const settings = {
			defaultMs: 300_000,
			overrides: {
				"minimax/minimax-m3": 120_000,
				"minimax-m3": 180_000,
			},
		}

		expect(resolveInferenceTimeoutMs(settings, { provider: "minimax", model: "minimax-m3" })).toBe(120_000)
		expect(resolveInferenceTimeoutMs(settings, { provider: "other", model: "minimax-m3" })).toBe(180_000)
		expect(resolveInferenceTimeoutMs(settings, { provider: "other", model: "glm" })).toBe(300_000)
	})
})
