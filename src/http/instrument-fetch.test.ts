import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installGlobalFetchInstrumentation } from "./instrument-fetch.js"
import { setStreamIdleTimeoutOverride } from "./stream-idle-timeout.js"

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

beforeEach(() => {
	baseCalls = []
	baseResponse = () => new Response("ok")
	// Idle timeout disabled so the idle layer passes straight through — its
	// behavior has its own suite in stream-idle-timeout.test.ts.
	setStreamIdleTimeoutOverride(0)
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		baseCalls.push({ input, init })
		return baseResponse()
	}) as typeof fetch
})

afterEach(() => {
	globalThis.fetch = realFetch
	setStreamIdleTimeoutOverride(undefined)
})

function install(onModelCompletionSettled?: (fetchFn: unknown) => Promise<unknown>) {
	installGlobalFetchInstrumentation({ userAgent: "kimchi-test/1.0", onModelCompletionSettled })
}

describe("installGlobalFetchInstrumentation", () => {
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
