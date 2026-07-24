import { afterEach, describe, expect, it, vi } from "vitest"
import { classifyLLMGatewayError } from "../llm-gateway-error.js"
import { getSettingsManager } from "../settings-watcher.js"
import {
	DEFAULT_STREAM_IDLE_TIMEOUT_MS,
	resolveStreamIdleTimeoutMs,
	STREAM_IDLE_TIMEOUT_ENV,
	StreamIdleTimeoutError,
	setStreamIdleTimeoutOverride,
	wrapFetchWithIdleTimeout,
} from "./stream-idle-timeout.js"

vi.mock("../settings-watcher.js", () => ({
	getSettingsManager: vi.fn(() => undefined),
}))

const mockedGetSettingsManager = vi.mocked(getSettingsManager)

function stubSettingsTimeout(value: number | (() => number) | undefined): void {
	if (value === undefined) {
		mockedGetSettingsManager.mockReturnValue(undefined)
		return
	}
	const getHttpIdleTimeoutMs = typeof value === "function" ? value : () => value
	mockedGetSettingsManager.mockReturnValue({ getHttpIdleTimeoutMs } as unknown as ReturnType<typeof getSettingsManager>)
}

const URL_UNDER_TEST = "https://llm.kimchi.dev/openai/v1/chat/completions"

/** A body stream that emits `chunks` then, if `hangAfter` is set, never resolves again. */
function makeStream(chunks: string[], opts: { hangAfter?: number } = {}): ReadableStream<Uint8Array> {
	const enc = new TextEncoder()
	let i = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (opts.hangAfter !== undefined && i >= opts.hangAfter) return // never resolve again
			if (i >= chunks.length) {
				controller.close()
				return
			}
			controller.enqueue(enc.encode(chunks[i++]))
		},
	})
}

async function drain(body: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!body) return ""
	const dec = new TextDecoder()
	let out = ""
	for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) out += dec.decode(chunk)
	return out
}

afterEach(() => {
	vi.unstubAllEnvs()
	setStreamIdleTimeoutOverride(undefined)
	stubSettingsTimeout(undefined)
})

describe("resolveStreamIdleTimeoutMs", () => {
	it("defaults when env is unset and no settings are readable", () => {
		expect(resolveStreamIdleTimeoutMs({})).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: "  " })).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
	})

	it("reads pi's httpIdleTimeoutMs setting", () => {
		stubSettingsTimeout(42_000)
		expect(resolveStreamIdleTimeoutMs({})).toBe(42_000)
	})

	it("falls back to the default when the settings read throws", () => {
		stubSettingsTimeout(() => {
			throw new Error("bad settings")
		})
		expect(resolveStreamIdleTimeoutMs({})).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS)
	})

	it("prefers the session override over settings", () => {
		stubSettingsTimeout(42_000)
		setStreamIdleTimeoutOverride(7_000)
		expect(resolveStreamIdleTimeoutMs({})).toBe(7_000)
	})

	it("lets the env var win over override and settings, including 0 (disabled)", () => {
		stubSettingsTimeout(42_000)
		setStreamIdleTimeoutOverride(7_000)
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: "5000" })).toBe(5000)
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: "0" })).toBe(0)
	})

	it("ignores malformed or negative env values", () => {
		setStreamIdleTimeoutOverride(7_000)
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: "abc" })).toBe(7_000)
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: "-1" })).toBe(7_000)
	})

	it("rejects unit-suffixed env values instead of truncating them to milliseconds", () => {
		setStreamIdleTimeoutOverride(7_000)
		// parseInt would turn "300s" into a 300ms timeout that kills every request.
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: "300s" })).toBe(7_000)
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: "5m" })).toBe(7_000)
		expect(resolveStreamIdleTimeoutMs({ [STREAM_IDLE_TIMEOUT_ENV]: "1.5" })).toBe(7_000)
	})

	it("re-reads a getter override on every resolution", () => {
		let timeout = 10_000
		setStreamIdleTimeoutOverride(() => timeout)
		expect(resolveStreamIdleTimeoutMs({})).toBe(10_000)
		timeout = 0
		expect(resolveStreamIdleTimeoutMs({})).toBe(0)
	})
})

describe("StreamIdleTimeoutError classification", () => {
	it("is classified as retryable infrastructure transport_failure", () => {
		const err = new StreamIdleTimeoutError(300_000, "llm.kimchi.dev", "body")
		const classified = classifyLLMGatewayError(err.message)
		expect(classified?.reason).toBe("transport_failure")
		expect(classified?.retryable).toBe(true)
		expect(classified?.isInfrastructure).toBe(true)
	})
})

describe("wrapFetchWithIdleTimeout", () => {
	it("passes requests through untouched when disabled (timeout 0)", async () => {
		setStreamIdleTimeoutOverride(0)
		const original = vi.fn(async () => new Response("ok"))
		const fetchFn = wrapFetchWithIdleTimeout(original as never)
		const res = await fetchFn(URL_UNDER_TEST)
		expect(await res.text()).toBe("ok")
		expect(original).toHaveBeenCalledOnce()
		// pass-through must not inject a signal
		expect(original.mock.calls[0][1 as never]).toBeUndefined()
	})

	it("streams a healthy body through unchanged", async () => {
		setStreamIdleTimeoutOverride(1000)
		const original = async () => new Response(makeStream(["a", "b", "c"]))
		const fetchFn = wrapFetchWithIdleTimeout(original as never)
		const res = await fetchFn(URL_UNDER_TEST)
		expect(await drain(res.body)).toBe("abc")
	})

	it("preserves url and redirected on the wrapped response", async () => {
		setStreamIdleTimeoutOverride(1000)
		const upstream = new Response(makeStream(["a"]))
		Object.defineProperties(upstream, {
			url: { get: () => "https://final.example/after-redirect" },
			redirected: { get: () => true },
		})
		const fetchFn = wrapFetchWithIdleTimeout((async () => upstream) as never)
		const res = await fetchFn(URL_UNDER_TEST)
		expect(res.url).toBe("https://final.example/after-redirect")
		expect(res.redirected).toBe(true)
		expect(await drain(res.body)).toBe("a")
	})

	it("resolves the timeout per request, so a settings change needs no rewrap", async () => {
		setStreamIdleTimeoutOverride(0)
		const original = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.signal).toBeUndefined()
			return new Response("ok")
		})
		const fetchFn = wrapFetchWithIdleTimeout(original as never)
		await fetchFn(URL_UNDER_TEST)
		setStreamIdleTimeoutOverride(1000)
		const withTimeout = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			expect(init?.signal).toBeInstanceOf(AbortSignal)
			return new Response("ok")
		})
		const fetchFn2 = wrapFetchWithIdleTimeout(withTimeout as never)
		await fetchFn2(URL_UNDER_TEST)
		expect(original).toHaveBeenCalledOnce()
		expect(withTimeout).toHaveBeenCalledOnce()
	})

	it("aborts the body when a chunk stalls past the idle window", async () => {
		vi.useFakeTimers()
		try {
			setStreamIdleTimeoutOverride(100)
			const original = async () => new Response(makeStream(["a", "b"], { hangAfter: 1 }))
			const fetchFn = wrapFetchWithIdleTimeout(original as never)
			const res = await fetchFn(URL_UNDER_TEST)
			const reader = (res.body as ReadableStream<Uint8Array>).getReader()
			const first = await reader.read()
			expect(new TextDecoder().decode(first.value)).toBe("a")
			const pending = reader.read() // second chunk never arrives
			const assertion = expect(pending).rejects.toBeInstanceOf(StreamIdleTimeoutError)
			await vi.advanceTimersByTimeAsync(150)
			await assertion
		} finally {
			vi.useRealTimers()
		}
	})

	it("aborts when response headers never arrive", async () => {
		vi.useFakeTimers()
		try {
			setStreamIdleTimeoutOverride(100)
			const original = (_input: RequestInfo | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
				})
			const fetchFn = wrapFetchWithIdleTimeout(original as never)
			const p = fetchFn(URL_UNDER_TEST)
			const assertion = expect(p).rejects.toBeInstanceOf(StreamIdleTimeoutError)
			await vi.advanceTimersByTimeAsync(150)
			await assertion
		} finally {
			vi.useRealTimers()
		}
	})
})

describe("wrapFetchWithIdleTimeout signal bridging", () => {
	it("bridges an abort signal carried on a Request-object input", async () => {
		setStreamIdleTimeoutOverride(60_000)
		const wrapped = wrapFetchWithIdleTimeout(
			(_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
				}),
		)
		const userController = new AbortController()
		const pending = wrapped(new Request("https://example.com/slow", { signal: userController.signal }))
		const cancellation = new Error("user cancelled")
		userController.abort(cancellation)
		await expect(pending).rejects.toBe(cancellation)
	})

	it("removes the abort-bridge listener from the caller signal once the body settles", async () => {
		setStreamIdleTimeoutOverride(60_000)
		const controller = new AbortController()
		const addSpy = vi.spyOn(controller.signal, "addEventListener")
		const removeSpy = vi.spyOn(controller.signal, "removeEventListener")
		const wrapped = wrapFetchWithIdleTimeout(async () => new Response(makeStream(["a"])))
		const response = await wrapped(URL_UNDER_TEST, { signal: controller.signal })
		await drain(response.body)
		const abortRegistrations = addSpy.mock.calls.filter(([type]) => type === "abort")
		expect(abortRegistrations).toHaveLength(1)
		expect(removeSpy).toHaveBeenCalledWith("abort", abortRegistrations[0][1])
	})
})
