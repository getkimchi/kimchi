import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { SessionContext, _resetSharedAccumulators } from "../session-context.js"
import { emitSessionStartEvent, handleSessionInitialized, handleSessionShutdown } from "./session.js"

vi.mock("../../ferment/index.js", () => ({
	getActiveFerment: vi.fn(() => undefined),
}))

vi.mock("../../../api/me.js", () => ({
	getMe: vi.fn().mockResolvedValue({ id: "test-user", email: "test@example.com" }),
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

describe("handleSessionInitialized", () => {
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

	it("resets context without emitting session.start", async () => {
		const ctx = new SessionContext(makeConfig(), "cli")
		handleSessionInitialized(ctx, "claude-opus-4-6")

		expect(ctx.currentModel).toBe("claude-opus-4-6")

		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])
		ctx.stopFlushTimer()

		// session.start should NOT be emitted by handleSessionInitialized
		expect(globalThis.fetch).not.toHaveBeenCalled()
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
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	it("emits kimchi.session.end with duration_ms and ended_by attributes", async () => {
		const { getActiveFerment } = await import("../../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)

		const ctx = new SessionContext(makeConfig(), "cli")
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
		expect(attrs.session_type).toBe("coding")
		expect(attrs.ferment_id).toBe("")
		expect(Number(attrs.duration_ms)).toBeGreaterThanOrEqual(0)
	})

	it("includes ferment_id when a ferment is active", async () => {
		const { getActiveFerment } = await import("../../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue({ id: "ferment-abc" } as never)

		const ctx = new SessionContext(makeConfig(), "cli")
		await handleSessionShutdown(ctx, { reason: "user_exit" })

		expect(globalThis.fetch).toHaveBeenCalled()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrs = Object.fromEntries(
			body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(
				(a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue],
			),
		)
		expect(attrs.ferment_id).toBe("ferment-abc")
	})

	it("emits session.type_changed before session.end when type drifted", async () => {
		const { getActiveFerment } = await import("../../ferment/index.js")
		// seed emit: 2 calls; shutdown: getSessionType(1) + type_changed emit(2) + end emit(2) = 5 calls
		vi.mocked(getActiveFerment)
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce(undefined)
			.mockReturnValueOnce({ id: "f-drift" } as never)
			.mockReturnValueOnce({ id: "f-drift" } as never)
			.mockReturnValueOnce({ id: "f-drift" } as never)
			.mockReturnValueOnce({ id: "f-drift" } as never)
			.mockReturnValueOnce({ id: "f-drift" } as never)

		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.emit("seed.event", {})
		await handleSessionShutdown(ctx, { reason: "user_exit" })

		const allRecords = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.flatMap(([, opts]: unknown[]) => {
			const body = JSON.parse((opts as { body: string }).body)
			return body.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords ?? []
		}) as Array<{
			eventName: string
			attributes: Array<{ key: string; value: { stringValue: string } }>
		}>

		const typeChangedRecord = allRecords.find((r) => r.eventName === "session.type_changed")
		if (!typeChangedRecord) expect.fail("expected session.type_changed record")
		const typeChangedAttrs = Object.fromEntries(
			typeChangedRecord.attributes.map((a: { key: string; value: { stringValue: string } }) => [
				a.key,
				a.value.stringValue,
			]),
		)
		expect(typeChangedAttrs.session_type).toBe("ferment")
		expect(typeChangedAttrs.previous_session_type).toBe("coding")
		expect(typeChangedAttrs.ferment_id).toBe("f-drift")

		const endRecord = allRecords.find((r) => r.eventName === "session.end")
		expect(endRecord).toBeDefined()
	})
})

describe("emitSessionStartEvent", () => {
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

	it("emits session.start with correct model attribute", async () => {
		const ctx = new SessionContext(makeConfig(), "cli")
		ctx.currentModel = "claude-opus-4-6"
		emitSessionStartEvent(ctx)

		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])
		ctx.stopFlushTimer()

		expect(globalThis.fetch).toHaveBeenCalled()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0]
		expect(logRecord.eventName).toBe("session.start")
		const attrs = Object.fromEntries(
			logRecord.attributes.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)
		expect(attrs.model).toBe("claude-opus-4-6")
		expect(attrs.source).toBe("cli")
		expect(attrs.ferment_id).toBe("")
	})
})
