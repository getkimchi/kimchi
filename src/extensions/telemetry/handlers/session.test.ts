import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { SessionContext } from "../session-context.js"
import { handleSessionShutdown, handleSessionStart } from "./session.js"

vi.mock("../../ferment/index.js", () => ({
	getActiveFerment: vi.fn(() => undefined),
}))

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "https://test.example.com/logs",
		metricsEndpoint: "https://test.example.com/metrics",
		headers: { Authorization: "Bearer test" },
		...overrides,
	}
}

describe("handleSessionStart", () => {
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

	it("resets context and emits kimchi.session.start with model from initialModel", async () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")
		handleSessionStart(ctx, "claude-opus-4-6")
		ctx.flushLogBuffer()

		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalled()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0]
		expect(logRecord.eventName).toBe("session.start")
		const attrs = Object.fromEntries(
			logRecord.attributes.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)
		expect(attrs.model).toBe("claude-opus-4-6")

		ctx.stopFlushTimer()
	})

	it("sets mode to ferment when getActiveFerment returns truthy", async () => {
		const { getActiveFerment } = await import("../../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue({ id: "test-ferment" } as never)

		const ctx = new SessionContext(makeConfig(), "cli", "coding")
		handleSessionStart(ctx)

		expect(ctx.mode).toBe("ferment")

		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])
		ctx.stopFlushTimer()
	})
})

describe("handleSessionShutdown", () => {
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

	it("emits kimchi.session.end with duration_ms and ended_by attributes", async () => {
		const ctx = new SessionContext(makeConfig(), "cli", "coding")
		await handleSessionShutdown(ctx, { reason: "user_exit" })

		expect(globalThis.fetch).toHaveBeenCalled()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0]
		expect(logRecord.eventName).toBe("session.end")

		const attrs = Object.fromEntries(
			logRecord.attributes.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)
		expect(attrs.ended_by).toBe("user_exit")
		expect(attrs.model).toBe("unknown")
		expect(attrs.source).toBe("cli")
		expect(attrs.mode).toBe("coding")
		expect(Number(attrs.duration_ms)).toBeGreaterThanOrEqual(0)
	})
})
