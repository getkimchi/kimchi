import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { routeQuery } from "./router-client.js"
import type { RouterConfig } from "./router-config.js"

const config: RouterConfig = { endpoint: "https://llm.kimchi.dev/", apiKey: "same-gateway-key" }

function response(body: unknown, ok = true): Response {
	return { ok, json: async () => body } as Response
}

describe("routeQuery", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("parses the best model and supported probability ranking", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			response({ best_model: "  kimi-k2.5 ", probabilities: { "kimi-k2.5": 0.9, "glm-5.2": 0.6 } }),
		)

		await expect(routeQuery("explain this", config, { fetchImpl })).resolves.toEqual({
			ok: true,
			recommendation: { bestModel: "kimi-k2.5", probabilities: { "kimi-k2.5": 0.9, "glm-5.2": 0.6 } },
		})
		expect(fetchImpl).toHaveBeenCalledWith(
			new URL("https://llm.kimchi.dev/v1/route"),
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json", "X-API-Key": "same-gateway-key" },
				body: JSON.stringify({ query: "explain this" }),
			}),
		)
	})

	it("forwards only telemetry correlation headers", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			response({ best_model: "kimi-k2.5", probabilities: { "kimi-k2.5": 1 } }),
		)

		await routeQuery("explain this", config, {
			fetchImpl,
			headers: {
				"x-session-id": "process-session",
				"X-Conversation-Id": "agent-session",
				"X-Turn-Index": "3",
				"X-Parent-Session-Id": "parent-session",
				traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
				Authorization: "Bearer provider-secret",
				"X-API-Key": "provider-override",
			},
		})

		expect(fetchImpl).toHaveBeenCalledWith(
			new URL("https://llm.kimchi.dev/v1/route"),
			expect.objectContaining({
				headers: {
					"X-Session-Id": "process-session",
					"X-Conversation-Id": "agent-session",
					"X-Turn-Index": "3",
					"X-Parent-Session-Id": "parent-session",
					traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
					"Content-Type": "application/json",
					"X-API-Key": "same-gateway-key",
				},
			}),
		)
	})

	it.each([
		["HTTP failure", response({}, false), "http"],
		["missing recommendation", response({ probabilities: {} }), "malformed"],
		["missing probabilities", response({ best_model: "kimi-k2.5" }), "malformed"],
		["null response", response(null), "malformed"],
		["array response", response([{ best_model: "kimi-k2.5" }]), "malformed"],
		["non-string recommendation", response({ best_model: 42, probabilities: {} }), "malformed"],
		["empty recommendation", response({ best_model: "  ", probabilities: {} }), "malformed"],
		[
			"non-numeric probabilities",
			response({ best_model: "kimi-k2.5", probabilities: { "kimi-k2.5": "high" } }),
			"malformed",
		],
	] as const)("classifies malformed %s responses", async (_label, result, reason) => {
		const fetchImpl = vi.fn<typeof fetch>(async () => result)
		await expect(routeQuery("task", config, { fetchImpl })).resolves.toEqual({ ok: false, reason })
	})

	it("distinguishes cancellation from timeout", async () => {
		const hangingFetch = vi.fn<typeof fetch>(
			async (_input, init) =>
				new Promise<Response>((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
				),
		)
		const external = new AbortController()
		const cancelled = routeQuery("task", config, { fetchImpl: hangingFetch, signal: external.signal })
		external.abort()
		await expect(cancelled).resolves.toEqual({ ok: false, reason: "cancelled" })

		const timedOut = routeQuery("task", config, { fetchImpl: hangingFetch })
		await vi.advanceTimersByTimeAsync(5100)
		await expect(timedOut).resolves.toEqual({ ok: false, reason: "timeout" })
	})
})
