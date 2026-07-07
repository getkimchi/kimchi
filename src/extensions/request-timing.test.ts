import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import requestTimingExtension from "./request-timing.js"

type Handler = (...args: unknown[]) => Promise<void> | void

function createMockApi() {
	const handlers = new Map<string, Handler[]>()
	const appendEntryCalls: Array<{ type: string; data: unknown }> = []
	const on = vi.fn((event: string, handler: Handler) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	const appendEntry = vi.fn((type: string, data: unknown) => {
		appendEntryCalls.push({ type, data })
	})
	return { on, handlers, appendEntry, appendEntryCalls, api: { on, appendEntry } as unknown as ExtensionAPI }
}

function getHandler(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler registered for ${event}`)
	return list[0]
}

describe("requestTimingExtension", () => {
	it("registers expected handlers", () => {
		const { handlers, api } = createMockApi()
		requestTimingExtension(api)

		expect(handlers.has("turn_start")).toBe(true)
		expect(handlers.has("before_provider_request")).toBe(true)
		expect(handlers.has("after_provider_response")).toBe(true)
		expect(handlers.has("message_end")).toBe(true)
	})

	it("emits a request_diagnostics entry after a provider response", async () => {
		const { handlers, api, appendEntry } = createMockApi()
		requestTimingExtension(api)

		const beforeProviderRequest = getHandler(handlers, "before_provider_request")
		const afterProviderResponse = getHandler(handlers, "after_provider_response")

		await beforeProviderRequest({})
		await afterProviderResponse({ status: 200, headers: { "x-trace-id": "trace-abc" } })

		expect(appendEntry).toHaveBeenCalledTimes(1)
		const call = appendEntry.mock.calls[0] as [string, Record<string, unknown>]
		expect(call[0]).toBe("request_diagnostics")
		expect(call[1].status).toBe(200)
		expect(call[1].traceId).toBe("trace-abc")
		expect(call[1].isRetry).toBe(false)
		expect(call[1].error).toBeUndefined()
		expect(typeof call[1].durationMs).toBe("number")
	})

	it("extracts trace ID from a native Headers object", async () => {
		const { handlers, api, appendEntry } = createMockApi()
		requestTimingExtension(api)

		const beforeProviderRequest = getHandler(handlers, "before_provider_request")
		const afterProviderResponse = getHandler(handlers, "after_provider_response")

		await beforeProviderRequest({})
		await afterProviderResponse({
			status: 200,
			headers: new Headers({ "x-trace-id": "headers-object-trace" }),
		})

		const call = appendEntry.mock.calls[0] as [string, Record<string, unknown>]
		expect(call[1].traceId).toBe("headers-object-trace")
	})

	it("extracts trace ID from a Headers object's entries() iterator", async () => {
		const { handlers, api, appendEntry } = createMockApi()
		requestTimingExtension(api)

		const beforeProviderRequest = getHandler(handlers, "before_provider_request")
		const afterProviderResponse = getHandler(handlers, "after_provider_response")

		const headers = new Headers()
		headers.append("X-Trace-Id", "entries-trace")

		await beforeProviderRequest({})
		await afterProviderResponse({ status: 200, headers })

		const call = appendEntry.mock.calls[0] as [string, Record<string, unknown>]
		expect(call[1].traceId).toBe("entries-trace")
	})

	it("clears lastError on before_provider_request so a successful retry does not carry the earlier error", async () => {
		const { handlers, api, appendEntry } = createMockApi()
		requestTimingExtension(api)

		const beforeProviderRequest = getHandler(handlers, "before_provider_request")
		const afterProviderResponse = getHandler(handlers, "after_provider_response")
		const messageEnd = getHandler(handlers, "message_end")

		// First request fails
		await beforeProviderRequest({})
		await messageEnd({ message: { stopReason: "error", errorMessage: "first failure" } })
		await afterProviderResponse({ status: 500, headers: {} })

		// Retry succeeds — lastError should have been cleared at the start of this request
		await beforeProviderRequest({})
		await afterProviderResponse({ status: 200, headers: {} })

		expect(appendEntry).toHaveBeenCalledTimes(2)
		const firstCall = appendEntry.mock.calls[0] as [string, Record<string, unknown>]
		const secondCall = appendEntry.mock.calls[1] as [string, Record<string, unknown>]
		expect(firstCall[1].error).toBe("first failure")
		expect(secondCall[1].error).toBeUndefined()
		expect(secondCall[1].isRetry).toBe(true)
	})

	it("marks a request as a retry only when a previous request in the same turn failed with 5xx/429", async () => {
		const { handlers, api, appendEntry } = createMockApi()
		requestTimingExtension(api)

		const beforeProviderRequest = getHandler(handlers, "before_provider_request")
		const afterProviderResponse = getHandler(handlers, "after_provider_response")

		await beforeProviderRequest({})
		await afterProviderResponse({ status: 200, headers: {} })

		await beforeProviderRequest({})
		await afterProviderResponse({ status: 200, headers: {} })

		expect(appendEntry).toHaveBeenCalledTimes(2)
		const firstCall = appendEntry.mock.calls[0] as [string, Record<string, unknown>]
		const secondCall = appendEntry.mock.calls[1] as [string, Record<string, unknown>]
		expect(firstCall[1].isRetry).toBe(false)
		expect(secondCall[1].isRetry).toBe(false)
	})
})
