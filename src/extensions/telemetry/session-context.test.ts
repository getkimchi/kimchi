import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../config.js"
import { SessionContext, _resetSharedAccumulators } from "./session-context.js"

vi.mock("../../api/me.js", () => ({
	getMe: vi.fn().mockResolvedValue({ id: "test-user", email: "test@example.com" }),
}))

vi.mock("../ferment/index.js", () => ({
	getActiveFerment: vi.fn(() => undefined),
}))

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "https://test.example.com/logs",
		metricsEndpoint: "https://test.example.com/metrics",
		headers: { Authorization: "Bearer test" },
		apiKey: "",
		...overrides,
	}
}

describe("SessionContext", () => {
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: vi.fn().mockResolvedValue(""),
		} as unknown as Response)
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	it("emit appends source and session_type to every event", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)

		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.emit("test.event", { custom: "value", count: 42 })
		ctx.flushLogBuffer()

		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes
		const attrMap = Object.fromEntries(
			attrs.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)

		expect(attrMap.source).toBe("cli")
		expect(attrMap.session_type).toBe("coding")
		expect(attrMap.ferment_id).toBe("")
		expect(attrMap.custom).toBe("value")
		expect(attrMap.count).toBe("42")
	})

	it("first emit seeds lastSessionType without firing session.type_changed", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)

		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.emit("test.event", {})
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const records = body.resourceLogs[0].scopeLogs[0].logRecords
		expect(records).toHaveLength(1)
		expect(records[0].eventName).toBe("test.event")
		expect(ctx.lastSessionType).toBe("coding")
	})

	it("emits session.type_changed before the original event on transition", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		// emit() calls getActiveFerment() twice per call (getSessionType + ferment lookup)
		vi.mocked(getActiveFerment)
			.mockReturnValueOnce(undefined) // emit 1, call 1
			.mockReturnValueOnce(undefined) // emit 1, call 2
			.mockReturnValueOnce({ id: "f-1" } as never) // emit 2, call 1
			.mockReturnValueOnce({ id: "f-1" } as never) // emit 2, call 2

		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.emit("event.first", {})
		ctx.emit("event.second", {})
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const records = body.resourceLogs[0].scopeLogs[0].logRecords
		expect(records).toHaveLength(3)

		expect(records[0].eventName).toBe("event.first")
		expect(records[1].eventName).toBe("session.type_changed")
		expect(records[2].eventName).toBe("event.second")

		const changeAttrs = Object.fromEntries(
			records[1].attributes.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)
		expect(changeAttrs.session_type).toBe("ferment")
		expect(changeAttrs.previous_session_type).toBe("coding")
		expect(changeAttrs.ferment_id).toBe("f-1")
		expect(changeAttrs.source).toBe("cli")
	})

	it("does not emit session.type_changed when type stays the same", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)

		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.emit("event.a", {})
		ctx.emit("event.b", {})
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])

		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const records = body.resourceLogs[0].scopeLogs[0].logRecords
		expect(records).toHaveLength(2)
		expect(records.every((r: { eventName: string }) => r.eventName !== "session.type_changed")).toBe(true)
	})

	it("emit buffers records instead of sending immediately", () => {
		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.emit("event.a", {})
		ctx.emit("event.b", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()
		expect(ctx.logBuffer).toHaveLength(2)
	})

	it("flushLogBuffer sends all buffered records in one POST", async () => {
		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.emit("event.a", {})
		ctx.emit("event.b", {})
		ctx.flushLogBuffer()

		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const records = body.resourceLogs[0].scopeLogs[0].logRecords
		expect(records).toHaveLength(2)
		expect(records[0].eventName).toBe("event.a")
		expect(records[1].eventName).toBe("event.b")
		expect(ctx.logBuffer).toHaveLength(0)
	})

	it("auto-flushes when buffer reaches LOG_BATCH_MAX_SIZE", async () => {
		const ctx = new SessionContext(makeConfig(), "cli")
		for (let i = 0; i < 20; i++) {
			ctx.emit(`event.${i}`, {})
		}

		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		expect(body.resourceLogs[0].scopeLogs[0].logRecords).toHaveLength(20)
		expect(ctx.logBuffer).toHaveLength(0)
	})

	it("timer-based flush sends buffered records after interval", async () => {
		vi.useFakeTimers()
		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.emit("event.a", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(5_001)

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		expect(ctx.logBuffer).toHaveLength(0)
		vi.useRealTimers()
	})

	it("drain flushes the log buffer", async () => {
		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.emit("event.a", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()

		await ctx.drain()

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		expect(ctx.logBuffer).toHaveLength(0)
	})

	it("reset clears log buffer", () => {
		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.emit("event.a", {})
		expect(ctx.logBuffer).toHaveLength(1)

		ctx.reset("vscode")
		expect(ctx.logBuffer).toHaveLength(0)
	})

	it("reset preserves rootSessionId and clears per-instance state", () => {
		const ctx = new SessionContext(makeConfig(), "cli")
		const originalId = ctx.sessionId

		ctx.sentMessages.add("msg-1")
		ctx.pendingArgs.set("msg-2", { toolName: "bash", args: {} })
		ctx.messageStartTimes.set("msg-3", Date.now())

		ctx.reset("vscode")

		expect(ctx.sessionId).toBe(originalId)
		expect(ctx.source).toBe("vscode")
		expect(ctx.sentMessages.size).toBe(0)
		expect(ctx.pendingArgs.size).toBe(0)
		expect(ctx.messageStartTimes.size).toBe(0)
		expect(ctx.shuttingDown).toBe(false)
	})

	it("track adds and removes promises from inFlight", async () => {
		const ctx = new SessionContext(makeConfig({ enabled: false }), "cli")

		let resolver: (() => void) | undefined
		const p = new Promise<void>((resolve) => {
			resolver = resolve
		})

		ctx.track(p)
		expect(ctx.inFlight.size).toBe(1)
		expect(ctx.inFlight.has(p)).toBe(true)

		resolver?.()
		// Wait for the finally handler to run
		await p
		// Microtask for finally
		await Promise.resolve()

		expect(ctx.inFlight.size).toBe(0)
	})

	it("track is a no-op when shuttingDown", () => {
		const ctx = new SessionContext(makeConfig({ enabled: false }), "cli")
		ctx.shuttingDown = true

		const p = new Promise<void>(() => {})
		ctx.track(p)
		expect(ctx.inFlight.size).toBe(0)
	})

	it("drain sets shuttingDown to true", async () => {
		const ctx = new SessionContext(makeConfig({ enabled: false }), "cli")
		expect(ctx.shuttingDown).toBe(false)

		await ctx.drain()
		expect(ctx.shuttingDown).toBe(true)
	})

	it("drain clears messageStartTimes and stops flush timer", async () => {
		const ctx = new SessionContext(makeConfig({ enabled: false }), "cli")
		ctx.messageStartTimes.set("msg-1", Date.now())
		ctx.startFlushTimer()
		expect(ctx.flushTimer).toBeDefined()

		await ctx.drain()

		expect(ctx.messageStartTimes.size).toBe(0)
		expect(ctx.flushTimer).toBeUndefined()
	})

	it("two instances share the same cumulative accumulator", () => {
		const ctx1 = new SessionContext(makeConfig(), "cli")
		const ctx2 = new SessionContext(makeConfig(), "cli")

		expect(ctx1.sessionId).toBe(ctx2.sessionId)
		expect(ctx1.cumulative).toBe(ctx2.cumulative)

		ctx1.cumulative.commitCount += 3
		expect(ctx2.cumulative.commitCount).toBe(3)
	})

	it("reset preserves shared accumulator data from other instances", () => {
		const ctx1 = new SessionContext(makeConfig(), "cli")
		const ctx2 = new SessionContext(makeConfig(), "cli")

		ctx1.cumulative.tokensByModel["test-model"] = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }

		ctx2.reset("cli")

		expect(ctx2.cumulative.tokensByModel["test-model"]?.output).toBe(50)
	})

	it("shared accumulators produce combined metrics on flush", async () => {
		const ctx1 = new SessionContext(makeConfig(), "cli")
		const ctx2 = new SessionContext(makeConfig(), "cli")

		ctx1.cumulative.tokensByModel.m1 = { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 }
		ctx2.cumulative.tokensByModel.m1.output += 50

		ctx1.flushMetrics()
		await Promise.allSettled([...ctx1.inFlight])

		const metricsCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]: unknown[]) =>
			String(url).includes("/metrics"),
		)
		expect(metricsCalls.length).toBe(1)
		const body = JSON.parse((metricsCalls[0][1] as { body: string }).body)
		const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics
		const outputMetric = metrics.find(
			(m: {
				name: string
				sum?: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> }
			}) =>
				m.name === "claude_code.token.usage" &&
				m.sum?.dataPoints[0]?.attributes?.some(
					(a: { key: string; value: { stringValue: string } }) => a.key === "type" && a.value.stringValue === "output",
				),
		)
		expect(outputMetric?.sum?.dataPoints[0]?.asInt).toBe("250")
	})

	it("fetches userEmail in background and includes it in log batch payloads", async () => {
		const { getMe } = await import("../../api/me.js")
		vi.mocked(getMe).mockResolvedValue({ id: "u1", email: "alice@test.com" })

		const ctx = new SessionContext(makeConfig({ apiKey: "my-key" }), "cli")
		await ctx.userEmailReady

		expect(ctx.userEmail).toBe("alice@test.com")

		ctx.emit("test.event", { foo: "bar" })
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalled()
		const logCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]: unknown[]) =>
			String(url).includes("/logs"),
		)
		expect(logCall).toBeDefined()
		const body = JSON.parse((logCall?.[1] as { body: string }).body)
		expect(body.userEmail).toBe("alice@test.com")
	})

	it("resolves userEmailReady even when getMe fails", async () => {
		const { getMe } = await import("../../api/me.js")
		vi.mocked(getMe).mockRejectedValue(new Error("network failure"))

		const ctx = new SessionContext(makeConfig({ apiKey: "my-key" }), "cli")
		await ctx.userEmailReady

		expect(ctx.userEmail).toBeUndefined()
	})

	it("resolves userEmailReady immediately when no apiKey", async () => {
		const ctx = new SessionContext(makeConfig({ apiKey: "" }), "cli")
		await ctx.userEmailReady
		expect(ctx.userEmail).toBeUndefined()
	})
})
