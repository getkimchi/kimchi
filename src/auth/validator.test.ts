import { describe, expect, it, vi } from "vitest"
import { validateApiKey } from "./validator.js"

type FetchWithRetryOptions = {
	fetchImpl?: typeof fetch
	timeoutMs?: number
	signal?: AbortSignal
	retry?: { maxRetries?: number }
}

const fetchWithRetrySpy = vi.fn((url: string, init?: RequestInit, options?: FetchWithRetryOptions) => {
	const fetchFn = options?.fetchImpl ?? globalThis.fetch
	const ctrl = new AbortController()
	if (options?.timeoutMs) {
		setTimeout(() => ctrl.abort(), options.timeoutMs)
	}
	const signals = [ctrl.signal, options?.signal, init?.signal].filter(Boolean) as AbortSignal[]
	const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]
	return fetchFn(url, { ...init, signal })
})

vi.mock("../utils/http.js", () => ({
	get fetchWithRetry() {
		return fetchWithRetrySpy
	},
}))

function fakeFetch(response: { status: number } | Error): typeof globalThis.fetch {
	return vi.fn(async () => {
		if (response instanceof Error) throw response
		return new Response(null, { status: response.status })
	}) as unknown as typeof globalThis.fetch
}

describe("validateApiKey", () => {
	it("rejects an empty key without making a request", async () => {
		const fetchSpy = vi.fn() as unknown as typeof globalThis.fetch
		const result = await validateApiKey("", { fetch: fetchSpy })
		expect(result.valid).toBe(false)
		expect(result.error).toMatch(/required/)
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it("returns valid:true on HTTP 200", async () => {
		const result = await validateApiKey("k", { fetch: fakeFetch({ status: 200 }) })
		expect(result).toEqual({ valid: true })
	})

	it("returns Invalid API key on 401 with actionable suggestions", async () => {
		const result = await validateApiKey("bad", { fetch: fakeFetch({ status: 401 }) })
		expect(result.valid).toBe(false)
		expect(result.error).toMatch(/Invalid/)
		expect(result.suggestions).toEqual(expect.arrayContaining([expect.stringMatching(/app\.kimchi\.dev/)]))
	})

	it("returns scope error on 403", async () => {
		const result = await validateApiKey("k", { fetch: fakeFetch({ status: 403 }) })
		expect(result.valid).toBe(false)
		expect(result.error).toMatch(/permissions/)
	})

	it("treats non-2xx/4xx as transient", async () => {
		const result = await validateApiKey("k", { fetch: fakeFetch({ status: 502 }) })
		expect(result.valid).toBe(false)
		expect(result.error).toMatch(/status 502/)
	})

	it("converts network failures to a friendly Network error result", async () => {
		const result = await validateApiKey("k", { fetch: fakeFetch(new Error("ENOTFOUND")) })
		expect(result.valid).toBe(false)
		expect(result.error).toMatch(/Network error/)
	})

	it("aborts the request after the configured timeout", async () => {
		const slow: typeof globalThis.fetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal as AbortSignal | undefined
				signal?.addEventListener("abort", () => reject(new Error("aborted")))
			})
		const result = await validateApiKey("k", { fetch: slow, timeoutMs: 5 })
		expect(result.valid).toBe(false)
		expect(result.error).toMatch(/Network error/)
	})

	it("forwards Authorization: Bearer header to the validation endpoint", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }))
		await validateApiKey("my-key", { fetch: fetchSpy as unknown as typeof globalThis.fetch })
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://api.cast.ai/v1/llm/openai/supported-providers",
			expect.objectContaining({
				headers: expect.objectContaining({ Authorization: "Bearer my-key" }),
			}),
		)
	})

	it("passes retry maxRetries: 1 to limit retries in interactive flows", async () => {
		fetchWithRetrySpy.mockClear()
		const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }))
		await validateApiKey("k", { fetch: fetchSpy as unknown as typeof globalThis.fetch })
		expect(fetchWithRetrySpy).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.objectContaining({ retry: { maxRetries: 1 } }),
		)
	})
})
