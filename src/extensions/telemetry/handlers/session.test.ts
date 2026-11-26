import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getMe } from "../../../api/me.js"
import type { TelemetryConfig } from "../../../config.js"
import { createContext } from "../../__mocks__/context.js"
import { createSideChatHost } from "../../__mocks__/side-chat-host.js"
import { getActiveFerment } from "../../ferment/index.js"
import { _resetSharedAccumulators, TelemetryContext } from "../session-context.js"
import { emitSessionStartEvent, handleSessionShutdown, handleSessionStart } from "./session.js"

/** The fake side-chat host the mocked getSideChatHost returns; undefined = host unavailable. */
const sideChatHostRef = vi.hoisted(() => ({ host: undefined as unknown }))

vi.mock("../../side-chat/harness.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../side-chat/harness.js")>()
	return {
		...actual,
		getSideChatHost: () => sideChatHostRef.host,
	}
})

vi.mock("../../ferment/index.js", () => ({
	getActiveFerment: vi.fn(),
}))

vi.mock("../../../api/me.js", () => ({
	getMe: vi.fn(),
}))

beforeEach(() => {
	vi.mocked(getActiveFerment).mockReset().mockReturnValue(undefined)
	vi.mocked(getMe).mockReset().mockResolvedValue({ id: "test-user", email: "test@example.com" })
	sideChatHostRef.host = undefined
})

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
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	it("resets context and starts flush timer without emitting session.start", async () => {
		const piCtx = createContext({ model: { id: "claude-opus-4-6" } })
		const ctx = new TelemetryContext(makeConfig())
		expect(ctx.flushTimer).toBeUndefined()

		handleSessionStart(ctx, piCtx)

		expect(ctx.flushTimer).toBeDefined()
		expect(ctx.currentModel).toBe("claude-opus-4-6")

		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])
		ctx.stopFlushTimer()

		// session.start should NOT be emitted by handleSessionStart
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

		const piCtx = createContext()
		const ctx = new TelemetryContext(makeConfig())
		await handleSessionShutdown(ctx, piCtx, { reason: "user_exit" })

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

		const piCtx = createContext()
		const ctx = new TelemetryContext(makeConfig())
		await handleSessionShutdown(ctx, piCtx, { reason: "user_exit" })

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

		const piCtx = createContext()
		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("seed.event", {})
		await handleSessionShutdown(ctx, piCtx, { reason: "user_exit" })

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
		expect(typeChangedAttrs["telemetry.cli_version"]).toBeDefined()

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
		const piCtx = createContext({ model: { id: "claude-opus-4-6" } })
		const ctx = new TelemetryContext(makeConfig())
		emitSessionStartEvent(ctx, piCtx)

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

describe("session.start tui_startup_mode", () => {
	let originalFetch: typeof globalThis.fetch
	let ctx: TelemetryContext

	/** Flush and parse the first emitted session.start record's attributes. */
	async function flushSessionStartAttrs(): Promise<Record<string, string>> {
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])
		ctx.stopFlushTimer()
		expect(globalThis.fetch).toHaveBeenCalled()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const logRecord = body.resourceLogs[0].scopeLogs[0].logRecords[0]
		expect(logRecord.eventName).toBe("session.start")
		return Object.fromEntries(
			logRecord.attributes.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)
	}

	beforeEach(() => {
		originalFetch = globalThis.fetch
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: vi.fn().mockResolvedValue(""),
		} as unknown as Response)
		ctx = new TelemetryContext(makeConfig())
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	it("captures and emits fullscreen for a fullscreen interactive TUI", async () => {
		const { host } = createSideChatHost()
		sideChatHostRef.host = host
		vi.mocked(host.isFullscreen).mockReturnValue(true)
		const piCtx = createContext()
		handleSessionStart(ctx, piCtx)
		emitSessionStartEvent(ctx, piCtx)

		expect(vi.mocked(host.isFullscreen)).toHaveBeenCalled()
		const attrs = await flushSessionStartAttrs()
		expect(attrs.tui_startup_mode).toBe("fullscreen")
	})

	it("captures and emits regular for a regular interactive TUI", async () => {
		const { host } = createSideChatHost()
		sideChatHostRef.host = host
		vi.mocked(host.isFullscreen).mockReturnValue(false)
		const piCtx = createContext()
		handleSessionStart(ctx, piCtx)
		emitSessionStartEvent(ctx, piCtx)

		const attrs = await flushSessionStartAttrs()
		expect(attrs.tui_startup_mode).toBe("regular")
	})

	it("omits the attribute for non-TUI run modes even when a fullscreen host exists", async () => {
		const { host } = createSideChatHost()
		sideChatHostRef.host = host
		vi.mocked(host.isFullscreen).mockReturnValue(true)
		for (const mode of ["rpc", "json", "print"] as const) {
			const piCtx = createContext({ mode })
			handleSessionStart(ctx, piCtx)
			emitSessionStartEvent(ctx, piCtx)

			const attrs = await flushSessionStartAttrs()
			expect(attrs.tui_startup_mode).toBeUndefined()
			;(globalThis.fetch as ReturnType<typeof vi.fn>).mockClear()
		}
	})

	it("omits the attribute when the TUI host/renderer is unavailable", async () => {
		sideChatHostRef.host = undefined
		const piCtx = createContext()
		handleSessionStart(ctx, piCtx)
		emitSessionStartEvent(ctx, piCtx)

		const attrs = await flushSessionStartAttrs()
		expect(attrs.tui_startup_mode).toBeUndefined()
	})

	it("samples the renderer at session_start, not when session.start is emitted", async () => {
		const piCtx = createContext()
		handleSessionStart(ctx, piCtx)
		// The host only becomes available after session_start (e.g. late init):
		// the snapshot must stay empty rather than being sampled at emit time.
		const { host } = createSideChatHost()
		sideChatHostRef.host = host
		emitSessionStartEvent(ctx, piCtx)

		const attrs = await flushSessionStartAttrs()
		expect(attrs.tui_startup_mode).toBeUndefined()
	})

	it("keeps the captured startup value when the renderer switches later", async () => {
		const { host } = createSideChatHost()
		sideChatHostRef.host = host
		vi.mocked(host.isFullscreen).mockReturnValue(true)
		const piCtx = createContext()
		handleSessionStart(ctx, piCtx)
		// The user switches to the regular renderer after startup.
		vi.mocked(host.isFullscreen).mockReturnValue(false)
		emitSessionStartEvent(ctx, piCtx)

		const attrs = await flushSessionStartAttrs()
		expect(attrs.tui_startup_mode).toBe("fullscreen")
	})

	it("resets and recaptures per session — no leak into a later session", async () => {
		const { host } = createSideChatHost()
		sideChatHostRef.host = host
		vi.mocked(host.isFullscreen).mockReturnValue(true)
		const piCtx = createContext()
		handleSessionStart(ctx, piCtx)
		emitSessionStartEvent(ctx, piCtx)
		expect((await flushSessionStartAttrs()).tui_startup_mode).toBe("fullscreen")

		;(globalThis.fetch as ReturnType<typeof vi.fn>).mockClear()
		// Same instance, later harness session — now a non-TUI run.
		const nextCtx = createContext({ mode: "print" })
		handleSessionStart(ctx, nextCtx)
		emitSessionStartEvent(ctx, nextCtx)
		expect((await flushSessionStartAttrs()).tui_startup_mode).toBeUndefined()

		;(globalThis.fetch as ReturnType<typeof vi.fn>).mockClear()
		// And a fresh TUI session recaptures the now-current renderer.
		vi.mocked(host.isFullscreen).mockReturnValue(false)
		handleSessionStart(ctx, piCtx)
		emitSessionStartEvent(ctx, piCtx)
		expect((await flushSessionStartAttrs()).tui_startup_mode).toBe("regular")
	})
})
