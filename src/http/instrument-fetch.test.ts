import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { installGlobalFetchInstrumentation as InstallGlobalFetchInstrumentation } from "./instrument-fetch.js"

vi.mock("../settings-watcher.js", () => ({
	getSettingsManager: vi.fn(() => undefined),
}))

const realFetch = globalThis.fetch

interface RecordedCall {
	input: RequestInfo | URL
	init?: RequestInit
}

let baseCalls: RecordedCall[]
let baseResponse: () => Response
let installGlobalFetchInstrumentation: typeof InstallGlobalFetchInstrumentation

beforeEach(async () => {
	// Every test installs a new global fetch; do not carry deferred callbacks from the previous wrapper.
	vi.resetModules()
	;({ installGlobalFetchInstrumentation } = await import("./instrument-fetch.js"))
	baseCalls = []
	baseResponse = () => new Response("ok")
	// Idle timeout disabled so the idle layer passes straight through — its
	// behavior has its own suite in stream-idle-timeout.test.ts.
	vi.stubEnv("KIMCHI_STREAM_IDLE_TIMEOUT_MS", "0")
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		baseCalls.push({ input, init })
		return baseResponse()
	}) as typeof fetch
})

afterEach(() => {
	globalThis.fetch = realFetch
	vi.unstubAllEnvs()
})

function install(onModelCompletionSettled?: (fetchFn: unknown) => Promise<unknown>) {
	installGlobalFetchInstrumentation({ userAgent: "kimchi-test/1.0", onModelCompletionSettled })
}

describe("installGlobalFetchInstrumentation", () => {
	it("passes only inspected JSON tags to attempt preparation without changing the body", async () => {
		const prepare = vi.fn()
		installGlobalFetchInstrumentation({ userAgent: "test", onModelRequest: prepare })
		const body = JSON.stringify({ messages: [{ content: "private prompt" }], tags: ["team:one", 123, " "] })
		await fetch("https://llm.test/v1/chat/completions", {
			method: "POST",
			headers: { "X-Request-Id": "request" },
			body,
		})
		expect(prepare.mock.calls[0][2]).toEqual({ bodyTags: ["team:one", " "] })
		expect(JSON.stringify(prepare.mock.calls[0][2])).not.toContain("private prompt")
		expect(baseCalls[0].init?.body).toBe(body)
	})
	it.each([
		"not-json",
		JSON.stringify({ tags: "team:one" }),
		"x".repeat(4_194_305),
	])("leaves uninspectable bodies untagged", async (body) => {
		const prepare = vi.fn()
		installGlobalFetchInstrumentation({ userAgent: "test", onModelRequest: prepare })
		await fetch("https://llm.test/v1/chat/completions", {
			method: "POST",
			headers: { "X-Request-Id": "request" },
			body,
		})
		expect(prepare.mock.calls[0][2]).toEqual({ bodyTags: undefined })
		expect(baseCalls[0].init?.body).toBe(body)
	})
	it("does not consume a Request object's body to inspect its tags", async () => {
		const prepare = vi.fn()
		installGlobalFetchInstrumentation({ userAgent: "test", onModelRequest: prepare })
		const input = new Request("https://llm.test/v1/chat/completions", {
			method: "POST",
			headers: { "X-Request-Id": "request" },
			body: JSON.stringify({ tags: [] }),
		})
		await fetch(input)
		expect(input.bodyUsed).toBe(false)
		expect(prepare.mock.calls[0][2]).toEqual({ bodyTags: undefined })
	})
	it("prepares each tracked dispatch using cloned headers and reports its outgoing identity", async () => {
		const observe = vi.fn()
		const prepare = vi.fn((headers: Headers) => {
			expect(baseCalls).toHaveLength(0)
			headers.set("X-Request-Id", "wire-attempt")
		})
		install()
		installGlobalFetchInstrumentation({ userAgent: "late-install", onModelRequest: prepare, onModelResponse: observe })
		const request = new Request("https://llm.test/openai/v1/chat/completions", {
			headers: { "X-Request-Id": "logical-request", Authorization: "Bearer keep" },
		})
		const response = await fetch(request)
		expect(prepare).toHaveBeenCalledOnce()
		expect(request.headers.get("x-request-id")).toBe("logical-request")
		const wire = new Headers(baseCalls[0].init?.headers)
		expect(wire.get("x-request-id")).toBe("wire-attempt")
		expect(wire.get("authorization")).toBe("Bearer keep")
		expect(observe).toHaveBeenCalledWith("wire-attempt", response)
	})
	it("continues without a request ID when durable attempt preparation fails", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		try {
			const observe = vi.fn()
			installGlobalFetchInstrumentation({
				userAgent: "test",
				onModelRequest: () => {
					throw Error("disk unavailable")
				},
				onModelResponse: observe,
			})
			const headers = { "X-Request-Id": "must-not-repeat", Authorization: "Bearer keep" }
			expect(await (await fetch("https://llm.test/v1/chat/completions", { headers })).text()).toBe("ok")
			expect(new Headers(baseCalls[0].init?.headers).has("x-request-id")).toBe(false)
			expect(new Headers(baseCalls[0].init?.headers).get("authorization")).toBe("Bearer keep")
			expect(headers["X-Request-Id"]).toBe("must-not-repeat")
			expect(observe).not.toHaveBeenCalled()
			expect(warning).toHaveBeenCalledOnce()
		} finally {
			warning.mockRestore()
		}
	})
	it("does not prepare untracked inference or non-model traffic", async () => {
		const prepare = vi.fn()
		installGlobalFetchInstrumentation({ userAgent: "test", onModelRequest: prepare })
		await fetch("https://llm.test/v1/models", { headers: { "X-Request-Id": "unrelated" } })
		await fetch("https://llm.test/v1/chat/completions")
		expect(prepare).not.toHaveBeenCalled()
	})
	it.each([
		"/openai/v1/chat/completions",
		"/anthropic/v1/messages",
		"/anthropic/v1/messages?beta=true",
		"/openai/v1/responses",
	])("observes a tracked response before reading %s, including HTTP errors", async (path) => {
		const observe = vi.fn()
		install()
		installGlobalFetchInstrumentation({ userAgent: "kimchi-test/1.0", onModelResponse: observe })
		baseResponse = () => new Response("untouched stream", { status: 503, headers: { "X-Prompt-Id": "billing-id" } })
		const response = await fetch(new Request(`https://llm.test${path}`, { headers: { "X-Request-Id": "request-id" } }))
		expect(observe).toHaveBeenCalledOnce()
		expect(observe).toHaveBeenCalledWith("request-id", expect.objectContaining({ status: 503 }))
		expect(observe.mock.calls[0][1].headers.get("X-Prompt-Id")).toBe("billing-id")
		expect(response.bodyUsed).toBe(false)
		expect(await response.text()).toBe("untouched stream")
	})
	it("does not observe unrelated traffic and keeps inference working if observation fails", async () => {
		const observe = vi.fn(() => {
			throw Error("ledger unavailable")
		})
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
		installGlobalFetchInstrumentation({ userAgent: "kimchi-test/1.0", onModelResponse: observe })
		await fetch("https://llm.test/v1/models", { headers: { "X-Request-Id": "request-id" } })
		await fetch("https://llm.test/openai/v1/chat/completions")
		expect(observe).not.toHaveBeenCalled()
		expect(
			await (
				await fetch("https://llm.test/openai/v1/chat/completions", { headers: { "X-Request-Id": "request-id" } })
			).text(),
		).toBe("ok")
		expect(observe).toHaveBeenCalledOnce()
		expect(warning).toHaveBeenCalledOnce()
		warning.mockRestore()
	})
	it("adds the default user-agent and preserves a caller-supplied one", async () => {
		install()
		await fetch("https://example.com/a")
		await fetch("https://example.com/b", { headers: { "user-agent": "custom-agent" } })
		expect(new Headers(baseCalls[0].init?.headers).get("user-agent")).toBe("kimchi-test/1.0")
		expect(new Headers(baseCalls[1].init?.headers).get("user-agent")).toBe("custom-agent")
	})

	it("preserves headers carried on a Request-object input", async () => {
		install()
		await fetch(new Request("https://example.com/a", { headers: { authorization: "Bearer tok" } }))
		const forwarded = new Headers(baseCalls[0].init?.headers)
		expect(forwarded.get("authorization")).toBe("Bearer tok")
		expect(forwarded.get("user-agent")).toBe("kimchi-test/1.0")
	})

	it("does not stack a second wrapper on repeat installs", async () => {
		install()
		const patched = globalThis.fetch
		install()
		expect(globalThis.fetch).toBe(patched)
		await fetch("https://example.com/a")
		expect(baseCalls).toHaveLength(1)
	})

	it("fires the billing hook once the completion body settles, and only for completion URLs", async () => {
		const hook = vi.fn(async () => {})
		install(hook)
		const completion = await fetch("https://llm.test/openai/v1/chat/completions")
		expect(hook).not.toHaveBeenCalled()
		await completion.text()
		expect(hook).toHaveBeenCalledTimes(1)
		await (await fetch("https://llm.test/v1/models/metadata")).text()
		expect(hook).toHaveBeenCalledTimes(1)
	})

	it("does not fire the billing hook for a failed completion (e.g. 429 budget exhausted)", async () => {
		const hook = vi.fn(async () => {})
		install(hook)
		baseResponse = () => new Response("budget exhausted", { status: 429 })
		await (await fetch("https://llm.test/openai/v1/chat/completions")).text()
		expect(hook).not.toHaveBeenCalled()
	})

	it("does not fire the billing hook for a 503 completion", async () => {
		const hook = vi.fn(async () => {})
		install(hook)
		baseResponse = () => new Response("Service Unavailable", { status: 503 })
		await (await fetch("https://llm.test/openai/v1/chat/completions")).text()
		expect(hook).not.toHaveBeenCalled()
	})

	it("attaches the billing hook to an already-installed fetch (entry.ts installs early, cli.ts attaches late)", async () => {
		install() // early install without hook, as entry.ts does
		const hook = vi.fn(async () => {})
		install(hook) // cli.ts's later call — install is a no-op, hook must still attach
		await (await fetch("https://llm.test/openai/v1/chat/completions")).text()
		expect(hook).toHaveBeenCalledTimes(1)
	})

	it("preserves url and redirected on billing-wrapped completion responses", async () => {
		install(vi.fn(async () => {}))
		baseResponse = () => {
			const response = new Response("data")
			Object.defineProperties(response, {
				url: { get: () => "https://llm.test/openai/v1/chat/completions" },
				redirected: { get: () => false },
			})
			return response
		}
		const completion = await fetch("https://llm.test/openai/v1/chat/completions")
		expect(completion.url).toBe("https://llm.test/openai/v1/chat/completions")
		expect(await completion.text()).toBe("data")
	})
})
