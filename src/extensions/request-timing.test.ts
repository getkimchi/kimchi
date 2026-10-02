import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BeforeProviderHeadersEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import requestTimingExtension from "./request-timing.js"
import { createWorkAttributionExtension, getWorkId, setWorkId } from "./work-attribution.js"

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

/** Simulate production event order: HTTP response, then assistant message_end. */
async function completeProviderCall(
	handlers: Map<string, Handler[]>,
	options: {
		status: number
		headers?: unknown
		errorMessage?: string
	},
) {
	const beforeProviderRequest = getHandler(handlers, "before_provider_request")
	const afterProviderResponse = getHandler(handlers, "after_provider_response")
	const messageEnd = getHandler(handlers, "message_end")

	await beforeProviderRequest({})
	await afterProviderResponse({ status: options.status, headers: options.headers ?? {} })
	await messageEnd({
		message: {
			role: "assistant",
			stopReason: options.errorMessage ? "error" : "stop",
			errorMessage: options.errorMessage,
		},
	})
}

describe("requestTimingExtension", () => {
	it("times consecutive fallback-only requests independently", async () => {
		const mock = createExtensionApi()
		const ctx = createContext()
		requestTimingExtension(mock.api)
		const now = vi.spyOn(Date, "now")
		try {
			for (const [start, end] of [
				[1000, 1030],
				[2000, 2020],
			]) {
				now.mockReturnValue(start)
				await mock.getHandler("before_provider_request")({}, ctx)
				now.mockReturnValue(end)
				await mock.getHandler("after_provider_response")({ status: 200, headers: {} }, ctx)
				for (const handler of mock.getHandlers("message_end"))
					await handler({ message: { role: "assistant", content: [] } }, ctx)
			}
			expect(mock.getAppendedEntries("request_diagnostics")).toEqual([
				expect.objectContaining({ requestStartedAt: new Date(1000).toISOString(), durationMs: 30 }),
				expect.objectContaining({ requestStartedAt: new Date(2000).toISOString(), durationMs: 20 }),
			])
		} finally {
			now.mockRestore()
		}
	})

	it.each([false, true])("uses this request's identity with timing registered first: %s", async (timingFirst) => {
		const dir = mkdtempSync(join(tmpdir(), "request-timing-"))
		vi.stubEnv("PI_CODING_AGENT_DIR", dir)
		try {
			const mock = createExtensionApi()
			const ctx = createContext({ cwd: dir })
			if (timingFirst) requestTimingExtension(mock.api)
			createWorkAttributionExtension()(mock.api)
			if (!timingFirst) requestTimingExtension(mock.api)
			const ids: string[] = []
			const workIds: string[] = []
			for (const status of [500, 200]) {
				await mock.getHandler("before_provider_request")({}, ctx)
				const event: BeforeProviderHeadersEvent = { type: "before_provider_headers", headers: {} }
				for (const handler of mock.getHandlers<BeforeProviderHeadersEvent>("before_provider_headers"))
					await handler(event, ctx)
				const requestId = event.headers["X-Request-Id"]
				if (typeof requestId !== "string") throw new Error("Expected an attributed request ID")
				ids.push(requestId)
				workIds.push(getWorkId(ctx))
				setWorkId(ctx)
				await mock.getHandler("after_provider_response")({ status, headers: {} }, ctx)
				for (const handler of mock.getHandlers("message_end"))
					await handler({ message: { role: "assistant", content: [] } }, ctx)
			}
			expect(ids[0]).not.toBe(ids[1])
			expect(mock.getAppendedEntries("request_diagnostics")).toEqual([
				expect.objectContaining({ requestId: ids[0], workId: workIds[0], isRetry: false }),
				expect.objectContaining({ requestId: ids[1], workId: workIds[1], isRetry: true }),
			])
			await mock.getHandler("before_provider_request")({}, ctx)
			await mock.getHandler("after_provider_response")({ status: 200, headers: {} }, ctx)
			for (const handler of mock.getHandlers("message_end"))
				await handler({ message: { role: "assistant", content: [] } }, ctx)
			const fallback = mock.getAppendedEntries("request_diagnostics").at(-1)
			expect(fallback).not.toHaveProperty("requestId")
			expect(fallback).not.toHaveProperty("workId")
		} finally {
			vi.unstubAllEnvs()
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("discards timing for a request that ends without an HTTP response", async () => {
		const mock = createExtensionApi()
		const ctx = createContext()
		requestTimingExtension(mock.api)
		const now = vi.spyOn(Date, "now").mockReturnValue(1000)
		try {
			await mock.getHandler("before_provider_request")({}, ctx)
			await mock.getHandler("message_end")({ message: { role: "assistant", stopReason: "error" } }, ctx)
			now.mockReturnValue(2000)
			await mock.getHandler("before_provider_request")({}, ctx)
			now.mockReturnValue(2010)
			await mock.getHandler("after_provider_response")({ status: 200, headers: {} }, ctx)
			await mock.getHandler("message_end")({ message: { role: "assistant" } }, ctx)
			expect(mock.getAppendedEntries("request_diagnostics")).toEqual([
				expect.objectContaining({ requestStartedAt: new Date(2000).toISOString(), durationMs: 10 }),
			])
		} finally {
			now.mockRestore()
		}
	})

	it("registers expected handlers", () => {
		const { handlers, api } = createMockApi()
		requestTimingExtension(api)

		expect(handlers.has("turn_start")).toBe(true)
		expect(handlers.has("before_provider_request")).toBe(true)
		expect(handlers.has("after_provider_response")).toBe(true)
		expect(handlers.has("message_end")).toBe(true)
	})

	it("emits a request_diagnostics entry after the assistant message is finalized", async () => {
		const { handlers, api, appendEntry } = createMockApi()
		requestTimingExtension(api)

		await completeProviderCall(handlers, {
			status: 200,
			headers: { "x-trace-id": "trace-abc" },
		})

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

		await completeProviderCall(handlers, {
			status: 200,
			headers: new Headers({ "x-trace-id": "headers-object-trace" }),
		})

		const call = appendEntry.mock.calls[0] as [string, Record<string, unknown>]
		expect(call[1].traceId).toBe("headers-object-trace")
	})

	it("extracts trace ID from a Headers object's entries() iterator", async () => {
		const { handlers, api, appendEntry } = createMockApi()
		requestTimingExtension(api)

		const headers = new Headers()
		headers.append("X-Trace-Id", "entries-trace")

		await completeProviderCall(handlers, { status: 200, headers })

		const call = appendEntry.mock.calls[0] as [string, Record<string, unknown>]
		expect(call[1].traceId).toBe("entries-trace")
	})

	it("attaches provider errors from message_end after the HTTP response", async () => {
		const { handlers, api, appendEntry } = createMockApi()
		requestTimingExtension(api)

		await completeProviderCall(handlers, {
			status: 500,
			errorMessage: "first failure",
		})

		expect(appendEntry).toHaveBeenCalledTimes(1)
		const call = appendEntry.mock.calls[0] as [string, Record<string, unknown>]
		expect(call[1].error).toBe("first failure")
	})

	it("does not carry an earlier error into a successful retry", async () => {
		const { handlers, api, appendEntry } = createMockApi()
		requestTimingExtension(api)

		await completeProviderCall(handlers, {
			status: 500,
			errorMessage: "first failure",
		})
		await completeProviderCall(handlers, { status: 200 })

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

		await completeProviderCall(handlers, { status: 200 })
		await completeProviderCall(handlers, { status: 200 })

		expect(appendEntry).toHaveBeenCalledTimes(2)
		const firstCall = appendEntry.mock.calls[0] as [string, Record<string, unknown>]
		const secondCall = appendEntry.mock.calls[1] as [string, Record<string, unknown>]
		expect(firstCall[1].isRetry).toBe(false)
		expect(secondCall[1].isRetry).toBe(false)
	})
})
