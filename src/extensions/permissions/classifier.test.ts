import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { classifyToolCall, parseClassifierOutput } from "./classifier.js"

const completeMock = vi.fn()

vi.mock("@earendil-works/pi-ai", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai")
	return {
		...actual,
		complete: (...args: unknown[]) => completeMock(...args),
	}
})

function fakeModel(id = "test-model"): Model<Api> {
	return { provider: "openai", id, api: "openai-completions" } as Model<Api>
}

function fakeRegistry(apiKey = "fake-key"): ModelRegistry {
	return {
		getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey, headers: {} }),
	} as unknown as ModelRegistry
}

function fakeResponse(opts: { stopReason: string; content?: string; errorMessage?: string }) {
	return {
		content: opts.content ? [{ type: "text", text: opts.content }] : [],
		stopReason: opts.stopReason,
		errorMessage: opts.errorMessage,
	}
}

describe("classifyToolCall", () => {
	beforeEach(() => {
		completeMock.mockReset()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("returns safe verdict on first attempt", async () => {
		completeMock.mockResolvedValue(fakeResponse({ stopReason: "stop", content: '{"verdict":"safe","reason":"fine"}' }))

		const result = await classifyToolCall(
			fakeModel(),
			fakeRegistry(),
			{ toolName: "bash", input: { command: "ls" }, cwd: "/tmp" },
			{ timeoutMs: 5000 },
		)

		expect(result.verdict).toBe("safe")
		expect(result.ok).toBe(true)
		expect(completeMock).toHaveBeenCalledTimes(1)
	})

	it("retries up to 3 times on abort before giving up", async () => {
		completeMock.mockResolvedValue(fakeResponse({ stopReason: "aborted" }))

		const promise = classifyToolCall(
			fakeModel("nemotron-test"),
			fakeRegistry(),
			{ toolName: "edit", input: { path: "foo.ts" }, cwd: "/tmp" },
			{ timeoutMs: 5000 },
		)

		await vi.runAllTimersAsync()
		const result = await promise

		expect(result.verdict).toBe("requires-confirmation")
		expect(result.ok).toBe(false)
		expect(result.reason).toContain("classifier timeout")
		expect(result.reason).toContain("nemotron-test")
		expect(completeMock).toHaveBeenCalledTimes(3)
	})

	it("succeeds on 2nd attempt after first abort", async () => {
		completeMock
			.mockResolvedValueOnce(fakeResponse({ stopReason: "aborted" }))
			.mockResolvedValueOnce(fakeResponse({ stopReason: "stop", content: '{"verdict":"safe","reason":"fine"}' }))

		const promise = classifyToolCall(
			fakeModel(),
			fakeRegistry(),
			{ toolName: "bash", input: { command: "ls" }, cwd: "/tmp" },
			{ timeoutMs: 5000 },
		)

		await vi.runAllTimersAsync()
		const result = await promise

		expect(result.verdict).toBe("safe")
		expect(result.ok).toBe(true)
		expect(completeMock).toHaveBeenCalledTimes(2)
	})

	it("succeeds on 3rd attempt after two aborts", async () => {
		completeMock
			.mockResolvedValueOnce(fakeResponse({ stopReason: "aborted" }))
			.mockResolvedValueOnce(fakeResponse({ stopReason: "aborted" }))
			.mockResolvedValueOnce(fakeResponse({ stopReason: "stop", content: '{"verdict":"safe","reason":"fine"}' }))

		const promise = classifyToolCall(
			fakeModel(),
			fakeRegistry(),
			{ toolName: "bash", input: { command: "ls" }, cwd: "/tmp" },
			{ timeoutMs: 5000 },
		)

		await vi.runAllTimersAsync()
		const result = await promise

		expect(result.verdict).toBe("safe")
		expect(result.ok).toBe(true)
		expect(completeMock).toHaveBeenCalledTimes(3)
	})

	it("returns 'classifier aborted' when signal aborts during final attempt", async () => {
		const controller = new AbortController()

		// First two attempts: timeout (retryable). Third attempt: also timeout,
		// but the outer signal is aborted during this attempt.
		let callCount = 0
		completeMock.mockImplementation(() => {
			callCount++
			if (callCount === 3) {
				// Simulate the outer signal aborting during the final classifier call
				controller.abort()
			}
			return fakeResponse({ stopReason: "aborted" })
		})

		const promise = classifyToolCall(
			fakeModel(),
			fakeRegistry(),
			{ toolName: "bash", input: { command: "ls" }, cwd: "/tmp" },
			{ timeoutMs: 5000 },
			controller.signal,
		)

		await vi.runAllTimersAsync()
		const result = await promise

		expect(completeMock).toHaveBeenCalledTimes(3)
		expect(result.verdict).toBe("requires-confirmation")
		expect(result.ok).toBe(false)
		expect(result.reason).toBe("classifier aborted")
	})

	it("does not retry when signal is aborted before first attempt", async () => {
		const controller = new AbortController()
		controller.abort()

		const result = await classifyToolCall(
			fakeModel(),
			fakeRegistry(),
			{ toolName: "bash", input: { command: "ls" }, cwd: "/tmp" },
			{ timeoutMs: 5000 },
			controller.signal,
		)

		expect(completeMock).not.toHaveBeenCalled()
		expect(result.reason).toBe("classifier aborted")
	})

	it("does not retry on error and returns requires-confirmation", async () => {
		completeMock.mockResolvedValue(fakeResponse({ stopReason: "error", errorMessage: "rate limit exceeded" }))

		const result = await classifyToolCall(
			fakeModel(),
			fakeRegistry(),
			{ toolName: "bash", input: { command: "ls" }, cwd: "/tmp" },
			{ timeoutMs: 5000 },
		)

		expect(completeMock).toHaveBeenCalledTimes(1)
		expect(result.verdict).toBe("requires-confirmation")
		expect(result.ok).toBe(false)
		expect(result.reason).toContain("classifier error: rate limit exceeded")
	})

	it("still falls back to unparseable when text is garbage", async () => {
		completeMock.mockResolvedValue(fakeResponse({ stopReason: "stop", content: "not json at all" }))

		const result = await classifyToolCall(
			fakeModel(),
			fakeRegistry(),
			{ toolName: "bash", input: { command: "ls" }, cwd: "/tmp" },
			{ timeoutMs: 5000 },
		)

		expect(result.verdict).toBe("requires-confirmation")
		expect(result.ok).toBe(false)
		expect(result.reason).toContain("unparseable")
	})
})

describe("parseClassifierOutput", () => {
	it("parses a valid safe verdict", () => {
		const r = parseClassifierOutput(`{ "verdict": "safe", "reason": "project build" }`)
		expect(r.verdict).toBe("safe")
		expect(r.reason).toBe("project build")
		expect(r.ok).toBe(true)
	})

	it("parses requires-confirmation", () => {
		const r = parseClassifierOutput(`{"verdict":"requires-confirmation","reason":"ambiguous"}`)
		expect(r.verdict).toBe("requires-confirmation")
	})

	it("parses blocked", () => {
		const r = parseClassifierOutput(`{"verdict":"blocked","reason":"destructive"}`)
		expect(r.verdict).toBe("blocked")
	})

	it("extracts embedded JSON when LLM adds prose", () => {
		const raw = `Sure. Here is my answer:\n\n{"verdict":"safe","reason":"fine"}\n\nHope that helps.`
		expect(parseClassifierOutput(raw).verdict).toBe("safe")
	})

	it("falls back to requires-confirmation on garbage", () => {
		const r = parseClassifierOutput("not json at all")
		expect(r.verdict).toBe("requires-confirmation")
		expect(r.reason).toContain("unparseable")
		expect(r.ok).toBe(false)
	})

	it("falls back on unknown verdict", () => {
		const r = parseClassifierOutput(`{"verdict":"maybe","reason":"x"}`)
		expect(r.verdict).toBe("requires-confirmation")
		expect(r.ok).toBe(false)
	})

	it("defaults reason when missing", () => {
		const r = parseClassifierOutput(`{"verdict":"safe"}`)
		expect(r.reason).toBe("no reason provided")
	})
})
