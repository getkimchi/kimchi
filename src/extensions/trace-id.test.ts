import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import traceIdExtension from "./trace-id.js"

type Handler = (...args: unknown[]) => Promise<void> | void

function createMockApi() {
	const handlers = new Map<string, Handler[]>()
	const appendEntryCalls: Array<{ type: string; data: unknown }> = []
	const on = vi.fn((event: string, handler: (...args: unknown[]) => Promise<void> | void) => {
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

describe("traceIdExtension", () => {
	describe("handler registration", () => {
		it("registers turn_start, after_provider_response, and turn_end handlers", () => {
			const { handlers, api } = createMockApi()
			traceIdExtension(api)

			expect(handlers.has("turn_start")).toBe(true)
			expect(handlers.has("after_provider_response")).toBe(true)
			expect(handlers.has("turn_end")).toBe(true)
		})
	})

	describe("turn_start resets buffer", () => {
		it("clears trace IDs on turn_start", async () => {
			const { handlers, api, appendEntry } = createMockApi()
			traceIdExtension(api)

			const turnStart = getHandler(handlers, "turn_start")
			const afterProviderResponse = getHandler(handlers, "after_provider_response")
			const turnEnd = getHandler(handlers, "turn_end")

			// First turn: capture a trace ID
			await turnStart({})
			await afterProviderResponse({
				headers: { "x-trace-id": "trace-abc-123" },
			})
			await turnEnd({ turnIndex: 0 })

			expect(appendEntry).toHaveBeenCalledWith("trace_ids", {
				traceIds: ["trace-abc-123"],
			})

			// Second turn: buffer should be cleared
			await turnStart({})
			await turnEnd({ turnIndex: 1 })

			// No additional appendEntry calls (no trace IDs in this turn)
			expect(appendEntry).toHaveBeenCalledTimes(1)
		})
	})

	describe("after_provider_response", () => {
		it("extracts trace ID from Headers object using .get()", async () => {
			const { handlers, api, appendEntry } = createMockApi()
			traceIdExtension(api)

			const turnStart = getHandler(handlers, "turn_start")
			const afterProviderResponse = getHandler(handlers, "after_provider_response")
			const turnEnd = getHandler(handlers, "turn_end")

			await turnStart({})
			await afterProviderResponse({
				headers: new Headers({ "x-trace-id": "trace-from-headers" }),
			})
			await turnEnd({ turnIndex: 0 })

			expect(appendEntry).toHaveBeenCalledWith("trace_ids", {
				traceIds: ["trace-from-headers"],
			})
		})

		it("extracts trace ID from plain object headers", async () => {
			const { handlers, api, appendEntry } = createMockApi()
			traceIdExtension(api)

			const turnStart = getHandler(handlers, "turn_start")
			const afterProviderResponse = getHandler(handlers, "after_provider_response")
			const turnEnd = getHandler(handlers, "turn_end")

			await turnStart({})
			await afterProviderResponse({
				headers: { "x-trace-id": "trace-from-object" },
			})
			await turnEnd({ turnIndex: 0 })

			expect(appendEntry).toHaveBeenCalledWith("trace_ids", {
				traceIds: ["trace-from-object"],
			})
		})

		it("handles missing x-trace-id gracefully", async () => {
			const { handlers, api, appendEntry } = createMockApi()
			traceIdExtension(api)

			const turnStart = getHandler(handlers, "turn_start")
			const afterProviderResponse = getHandler(handlers, "after_provider_response")
			const turnEnd = getHandler(handlers, "turn_end")

			await turnStart({})
			await afterProviderResponse({
				headers: new Headers({ "content-type": "application/json" }),
			})
			await turnEnd({ turnIndex: 0 })

			expect(appendEntry).not.toHaveBeenCalled()
		})

		it("handles empty/missing headers gracefully", async () => {
			const { handlers, api, appendEntry } = createMockApi()
			traceIdExtension(api)

			const turnStart = getHandler(handlers, "turn_start")
			const afterProviderResponse = getHandler(handlers, "after_provider_response")
			const turnEnd = getHandler(handlers, "turn_end")

			await turnStart({})

			// No response headers
			await afterProviderResponse({ headers: {} })
			await turnEnd({ turnIndex: 0 })
			expect(appendEntry).not.toHaveBeenCalled()

			// Missing headers entirely
			await turnStart({})
			await afterProviderResponse({})
			await turnEnd({ turnIndex: 1 })
			expect(appendEntry).not.toHaveBeenCalled()
		})
	})

	describe("turn_end", () => {
		it("does not call appendEntry when there are no trace IDs", async () => {
			const { handlers, api, appendEntry } = createMockApi()
			traceIdExtension(api)

			const turnStart = getHandler(handlers, "turn_start")
			const turnEnd = getHandler(handlers, "turn_end")

			await turnStart({})
			// No provider responses at all
			await turnEnd({ turnIndex: 0 })

			expect(appendEntry).not.toHaveBeenCalled()
		})

		it("captures single trace ID correctly on turn_end", async () => {
			const { handlers, api, appendEntry } = createMockApi()
			traceIdExtension(api)

			const turnStart = getHandler(handlers, "turn_start")
			const afterProviderResponse = getHandler(handlers, "after_provider_response")
			const turnEnd = getHandler(handlers, "turn_end")

			await turnStart({})
			await afterProviderResponse({
				headers: { "x-trace-id": "trace-single-123" },
			})
			await turnEnd({ turnIndex: 2 })

			expect(appendEntry).toHaveBeenCalledWith("trace_ids", {
				traceIds: ["trace-single-123"],
			})
		})

		it("captures multiple trace IDs from multiple provider responses within a turn", async () => {
			const { handlers, api, appendEntry } = createMockApi()
			traceIdExtension(api)

			const turnStart = getHandler(handlers, "turn_start")
			const afterProviderResponse = getHandler(handlers, "after_provider_response")
			const turnEnd = getHandler(handlers, "turn_end")

			await turnStart({})
			await afterProviderResponse({
				headers: { "x-trace-id": "trace-first" },
			})
			await afterProviderResponse({
				headers: { "x-trace-id": "trace-second" },
			})
			await afterProviderResponse({
				headers: { "x-trace-id": "trace-third" },
			})
			await turnEnd({ turnIndex: 0 })

			expect(appendEntry).toHaveBeenCalledWith("trace_ids", {
				traceIds: ["trace-first", "trace-second", "trace-third"],
			})
		})

		it("deduplicates duplicate trace IDs within a turn", async () => {
			const { handlers, api, appendEntry } = createMockApi()
			traceIdExtension(api)

			const turnStart = getHandler(handlers, "turn_start")
			const afterProviderResponse = getHandler(handlers, "after_provider_response")
			const turnEnd = getHandler(handlers, "turn_end")

			await turnStart({})
			await afterProviderResponse({
				headers: { "x-trace-id": "trace-dup" },
			})
			await afterProviderResponse({
				headers: { "x-trace-id": "trace-dup" },
			})
			await afterProviderResponse({
				headers: { "x-trace-id": "trace-dup" },
			})
			await turnEnd({ turnIndex: 0 })

			expect(appendEntry).toHaveBeenCalledWith("trace_ids", {
				traceIds: ["trace-dup"],
			})
		})
	})
})
