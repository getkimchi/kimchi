import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../config.js"
import { SessionContext } from "./session-context.js"

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "https://test.example.com/logs",
		metricsEndpoint: "https://test.example.com/metrics",
		headers: { Authorization: "Bearer test" },
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
		vi.restoreAllMocks()
	})

	it("emit appends source and mode to every event", async () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")
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
		expect(attrMap.mode).toBe("coding")
		expect(attrMap.custom).toBe("value")
		expect(attrMap.count).toBe("42")
	})

	it("emit buffers records instead of sending immediately", () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")
		ctx.emit("event.a", {})
		ctx.emit("event.b", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()
		expect(ctx.logBuffer).toHaveLength(2)
	})

	it("flushLogBuffer sends all buffered records in one POST", async () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")
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
		const ctx = new SessionContext(makeConfig(), "cli", "coding")
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
		const ctx = new SessionContext(makeConfig(), "cli", "coding")
		ctx.emit("event.a", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(5_001)

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		expect(ctx.logBuffer).toHaveLength(0)
		vi.useRealTimers()
	})

	it("drain flushes the log buffer", async () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")
		ctx.emit("event.a", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()

		await ctx.drain()

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		expect(ctx.logBuffer).toHaveLength(0)
	})

	it("reset clears log buffer", () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")
		ctx.emit("event.a", {})
		expect(ctx.logBuffer).toHaveLength(1)

		ctx.reset("vscode", "ferment")
		expect(ctx.logBuffer).toHaveLength(0)
	})

	it("reset generates new sessionId and clears state", () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")
		const originalId = ctx.sessionId

		ctx.sentMessages.add("msg-1")
		ctx.pendingArgs.set("msg-2", { toolName: "bash", args: {} })
		ctx.messageStartTimes.set("msg-3", Date.now())

		ctx.reset("vscode", "ferment")

		expect(ctx.sessionId).not.toBe(originalId)
		expect(ctx.source).toBe("vscode")
		expect(ctx.mode).toBe("ferment")
		expect(ctx.sentMessages.size).toBe(0)
		expect(ctx.pendingArgs.size).toBe(0)
		expect(ctx.messageStartTimes.size).toBe(0)
		expect(ctx.shuttingDown).toBe(false)
	})

	it("track adds and removes promises from inFlight", async () => {
		const ctx = new SessionContext(makeConfig({ enabled: false }), "cli", "coding")

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
		const ctx = new SessionContext(makeConfig({ enabled: false }), "cli", "coding")
		ctx.shuttingDown = true

		const p = new Promise<void>(() => {})
		ctx.track(p)
		expect(ctx.inFlight.size).toBe(0)
	})

	it("drain sets shuttingDown to true", async () => {
		const ctx = new SessionContext(makeConfig({ enabled: false }), "cli", "coding")
		expect(ctx.shuttingDown).toBe(false)

		await ctx.drain()
		expect(ctx.shuttingDown).toBe(true)
	})

	it("drain clears messageStartTimes and stops flush timer", async () => {
		const ctx = new SessionContext(makeConfig({ enabled: false }), "cli", "coding")
		ctx.messageStartTimes.set("msg-1", Date.now())
		ctx.startFlushTimer()
		expect(ctx.flushTimer).toBeDefined()

		await ctx.drain()

		expect(ctx.messageStartTimes.size).toBe(0)
		expect(ctx.flushTimer).toBeUndefined()
	})
})
