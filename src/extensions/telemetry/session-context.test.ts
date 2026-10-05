import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../config.js"
import * as osMetadata from "../../utils/os-metadata.js"
import { createContext } from "../__mocks__/context.js"
import { PARENT_SESSION_ID_ENV_KEY } from "../agents/manager/constants.js"
import { setTelemetryFermentV2Context } from "./ferment-v2-context.js"
import { _resetSharedAccumulators, TelemetryContext } from "./session-context.js"

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
		vi.unstubAllEnvs()
		// session.parent_id simulation env — never leak the subagent worker flag
		// or the parent session id into sibling tests.
		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		Reflect.deleteProperty(process.env, PARENT_SESSION_ID_ENV_KEY)
	})

	it("flushes PR health without adding user or session labels", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		const ctx = new TelemetryContext(makeConfig())
		ctx.setPiSessionId("private-session")
		ctx.userId = "private-user"
		ctx.cumulative.prCost = { matching: { explicit: 1 }, delivery: {}, queueDepth: 0, startTimeUnixNano: "1000000000" }
		ctx.flushMetrics()
		await Promise.allSettled([...ctx.inFlight])
		const [, options] = vi.mocked(globalThis.fetch).mock.calls[0]
		const body = JSON.parse(String(options?.body))
		const serialized = JSON.stringify(body)
		expect(serialized).not.toContain("private-session")
		expect(serialized).not.toContain("private-user")
		expect(serialized).not.toContain("user.account_uuid")
		expect(serialized).not.toContain("session.id")
		expect(body.resourceMetrics[0].scopeMetrics[0].metrics).toHaveLength(2)
	})

	it("drops buffered PR health when telemetry is turned off before flush", async () => {
		const ctx = new TelemetryContext(makeConfig())
		ctx.cumulative.prCost = { matching: { explicit: 1 }, delivery: {}, startTimeUnixNano: "1000000000" }
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		ctx.flushMetrics()
		await Promise.allSettled([...ctx.inFlight])
		expect(globalThis.fetch).not.toHaveBeenCalled()
		expect(ctx.cumulative.prCost).toBeUndefined()
	})

	it("rechecks PR health consent after pending identity lookup", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		const ctx = new TelemetryContext(makeConfig())
		let release!: () => void
		ctx.userEmailReady = new Promise<void>((resolve) => {
			release = resolve
		})
		ctx.cumulative.prCost = { matching: { explicit: 1 }, delivery: {}, startTimeUnixNano: "1000000000" }
		ctx.flushMetrics()
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		release()
		await Promise.allSettled([...ctx.inFlight])
		expect(globalThis.fetch).not.toHaveBeenCalled()
		expect(ctx.cumulative.prCost).toBeUndefined()
	})

	it("does not retry a PR health batch after telemetry is turned off", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		vi.spyOn(Math, "random").mockReturnValue(0)
		vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
			vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
			return new Response(null, { status: 503 })
		})
		const ctx = new TelemetryContext(makeConfig())
		ctx.cumulative.prCost = { matching: { explicit: 1 }, delivery: {}, startTimeUnixNano: "1000000000" }
		ctx.flushMetrics()
		await Promise.allSettled([...ctx.inFlight])
		expect(globalThis.fetch).toHaveBeenCalledOnce()
	})

	it("does not restore a discarded batch if telemetry is re-enabled before identity resolves", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		const ctx = new TelemetryContext(makeConfig())
		let release!: () => void
		ctx.userEmailReady = new Promise<void>((resolve) => {
			release = resolve
		})
		ctx.cumulative.prCost = { matching: { explicit: 4 }, delivery: {}, startTimeUnixNano: "1000000000" }
		ctx.flushMetrics()
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		ctx.flushMetrics()
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		ctx.cumulative.prCost = { matching: { session: 1 }, delivery: {}, startTimeUnixNano: "2000000000" }
		ctx.flushMetrics()
		release()
		await Promise.allSettled([...ctx.inFlight])
		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body))
		expect(body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].startTimeUnixNano).toBe("2000000000")
	})

	it("does not retry discarded health counts after telemetry is re-enabled", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		vi.spyOn(Math, "random").mockReturnValue(0)
		const ctx = new TelemetryContext(makeConfig())
		ctx.cumulative.prCost = { matching: { explicit: 4 }, delivery: {}, startTimeUnixNano: "1000000000" }
		vi.mocked(globalThis.fetch).mockImplementationOnce(async () => {
			vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
			ctx.flushMetrics()
			vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
			ctx.cumulative.prCost = { matching: { session: 1 }, delivery: {}, startTimeUnixNano: "2000000000" }
			return new Response(null, { status: 503 })
		})
		ctx.flushMetrics()
		await Promise.allSettled([...ctx.inFlight])
		expect(globalThis.fetch).toHaveBeenCalledOnce()

		ctx.flushMetrics()
		await Promise.allSettled([...ctx.inFlight])
		expect(globalThis.fetch).toHaveBeenCalledTimes(2)
		const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[1][1]?.body))
		expect(body.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].startTimeUnixNano).toBe("2000000000")
	})

	it("emit appends source and session_type to every event", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)

		const ctx = new TelemetryContext(makeConfig())
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

	it("emit includes all four OS metadata keys", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)

		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("test.event", { custom: "value" })
		ctx.flushLogBuffer()

		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes
		const attrMap = Object.fromEntries(
			attrs.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)

		// All four OS metadata keys should be present
		expect(attrMap["telemetry.os"]).toBe(process.platform)
		const expectedArch = process.arch === "x64" ? "amd64" : process.arch
		expect(attrMap["telemetry.arch"]).toBe(expectedArch)
		expect(attrMap["telemetry.host_os"]).toBe(process.platform) // non-WSL in test env
		expect(attrMap["telemetry.is_wsl"]).toBe("false") // toAttrs converts boolean to string
	})

	// Parametrized WSL counterpart to the non-WSL test above. SessionContext
	// caches osMetadata in its constructor, so the spy MUST be in place before
	// `new SessionContext(...)` is called. toAttrs converts booleans to strings,
	// so is_wsl arrives as the string "true".
	it("emit reports host_os=win32 and is_wsl=true under WSL", async () => {
		vi.spyOn(osMetadata, "getOsMetadata").mockReturnValue({
			"telemetry.os": "linux",
			"telemetry.arch": "amd64",
			"telemetry.host_os": "win32",
			"telemetry.is_wsl": true,
		})
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)

		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("test.event", { custom: "value" })
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes
		const attrMap = Object.fromEntries(
			attrs.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)

		expect(attrMap["telemetry.os"]).toBe("linux")
		expect(attrMap["telemetry.host_os"]).toBe("win32")
		expect(attrMap["telemetry.is_wsl"]).toBe("true") // toAttrs converts boolean to string
		expect(attrMap["telemetry.arch"]).toBe("amd64")
	})

	it("emitWithIds includes all four OS metadata keys", async () => {
		const ctx = new TelemetryContext(makeConfig())
		ctx.emitWithIds("ferment.started", { ferment_id: "f-123" })
		ctx.flushLogBuffer()

		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes
		const attrMap = Object.fromEntries(
			attrs.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)

		expect(attrMap["telemetry.os"]).toBe(process.platform)
		const expectedArch = process.arch === "x64" ? "amd64" : process.arch
		expect(attrMap["telemetry.arch"]).toBe(expectedArch)
		expect(attrMap["telemetry.host_os"]).toBe(process.platform)
		expect(attrMap["telemetry.is_wsl"]).toBe("false")
	})

	it("first emit seeds lastSessionType without firing session.type_changed", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)

		const ctx = new TelemetryContext(makeConfig())
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

		const ctx = new TelemetryContext(makeConfig())
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

	it("prefers active Ferment V2 attribution over legacy Ferment on ambient events", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue({ id: "f-v1" } as never)
		setTelemetryFermentV2Context({ id: "fv2-active", revision: 7, status: "paused" })

		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("test.event", {})
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])

		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes
		const attrMap = Object.fromEntries(
			attrs.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)
		expect(attrMap.session_type).toBe("ferment")
		expect(attrMap.ferment_id).toBe("fv2-active")
		expect(attrMap.ferment_v2_id).toBe("fv2-active")
		expect(attrMap.ferment_version).toBe("v2")
		expect(attrMap.ferment_revision).toBe("7")
		expect(attrMap.status).toBe("paused")
	})

	it("suppresses raw error message fields only on V2-attributed ambient events", async () => {
		setTelemetryFermentV2Context({ id: "fv2-active", revision: 7, status: "active" })

		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("message.error", {
			error_message: "raw provider error",
			"error.message": "raw nested provider error",
			error_type: "provider",
			"error.type": "provider",
		})
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])

		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes
		const attrMap = Object.fromEntries(
			attrs.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)
		expect(attrMap.ferment_version).toBe("v2")
		expect(attrMap.error_type).toBe("provider")
		expect(attrMap["error.type"]).toBe("provider")
		expect(attrMap.error_message).toBeUndefined()
		expect(attrMap["error.message"]).toBeUndefined()
	})

	it("keeps legacy error message fields when no V2 context is active", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue({ id: "f-v1" } as never)

		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("message.error", {
			error_message: "legacy raw error",
			"error.message": "legacy nested raw error",
			error_type: "provider",
		})
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])

		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrs = body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes
		const attrMap = Object.fromEntries(
			attrs.map((a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue]),
		)
		expect(attrMap.ferment_id).toBe("f-v1")
		expect(attrMap.ferment_version).toBeUndefined()
		expect(attrMap.error_message).toBe("legacy raw error")
		expect(attrMap["error.message"]).toBe("legacy nested raw error")
	})

	it("does not emit session.type_changed when type stays the same", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)

		const ctx = new TelemetryContext(makeConfig())
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
		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("event.a", {})
		ctx.emit("event.b", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()
		expect(ctx.logBuffer).toHaveLength(2)
	})

	it("flushLogBuffer sends all buffered records in one POST", async () => {
		const ctx = new TelemetryContext(makeConfig())
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
		const ctx = new TelemetryContext(makeConfig())
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
		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("event.a", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(5_001)

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		expect(ctx.logBuffer).toHaveLength(0)
		vi.useRealTimers()
	})

	it("drain flushes the log buffer", async () => {
		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("event.a", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()

		await ctx.drain()

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		expect(ctx.logBuffer).toHaveLength(0)
	})

	it("track adds and removes promises from inFlight", async () => {
		const ctx = new TelemetryContext(makeConfig({ enabled: false }))

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
		const ctx = new TelemetryContext(makeConfig({ enabled: false }))
		ctx.shuttingDown = true

		const p = new Promise<void>(() => {})
		ctx.track(p)
		expect(ctx.inFlight.size).toBe(0)
	})

	it("drain sets shuttingDown to true", async () => {
		const ctx = new TelemetryContext(makeConfig({ enabled: false }))
		expect(ctx.shuttingDown).toBe(false)

		await ctx.drain()
		expect(ctx.shuttingDown).toBe(true)
	})

	it("drain clears messageStartTimes and stops flush timer", async () => {
		const ctx = new TelemetryContext(makeConfig({ enabled: false }))
		ctx.messageStartTimes.set("msg-1", Date.now())
		ctx.startFlushTimer()
		expect(ctx.flushTimer).toBeDefined()

		await ctx.drain()

		expect(ctx.messageStartTimes.size).toBe(0)
		expect(ctx.flushTimer).toBeUndefined()
	})

	it("two instances share the same cumulative accumulator", () => {
		const ctx1 = new TelemetryContext(makeConfig())
		const ctx2 = new TelemetryContext(makeConfig())

		expect(ctx1.telemetryId).toBe(ctx2.telemetryId)
		expect(ctx1.cumulative).toBe(ctx2.cumulative)

		ctx1.cumulative.commitCount += 3
		expect(ctx2.cumulative.commitCount).toBe(3)
	})

	it("shared accumulators produce combined metrics on flush", async () => {
		const ctx1 = new TelemetryContext(makeConfig())
		const ctx2 = new TelemetryContext(makeConfig())

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

		const ctx = new TelemetryContext(makeConfig({ apiKey: "my-key" }))
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

		const ctx = new TelemetryContext(makeConfig({ apiKey: "my-key" }))
		await ctx.userEmailReady

		expect(ctx.userEmail).toBeUndefined()
	})

	it("resolves userEmailReady immediately when no apiKey", async () => {
		const ctx = new TelemetryContext(makeConfig({ apiKey: "" }))
		await ctx.userEmailReady
		expect(ctx.userEmail).toBeUndefined()
	})

	it("emit includes user.account_uuid from userId after getMe resolves", async () => {
		const { getMe } = await import("../../api/me.js")
		vi.mocked(getMe).mockResolvedValue({ id: "user-uuid-123" })

		const ctx = new TelemetryContext(makeConfig({ apiKey: "key" }))
		await ctx.userEmailReady

		ctx.emit("test.event", { foo: "bar" })
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])

		const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(([url]: unknown[]) =>
			String(url).includes("/logs"),
		)
		const body = JSON.parse((call?.[1] as { body: string }).body)
		const attrMap = Object.fromEntries(
			body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(
				(a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue],
			),
		)
		expect(attrMap["user.account_uuid"]).toBe("user-uuid-123")
	})

	it("emit adds session.parent_id when running inside a subagent", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)
		process.env.KIMCHI_SUBAGENT = "1"
		process.env[PARENT_SESSION_ID_ENV_KEY] = "parent-session-1"

		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("test.event", { custom: "value" })
		ctx.flushLogBuffer()

		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrMap = Object.fromEntries(
			body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(
				(a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue],
			),
		)

		expect(attrMap["session.parent_id"]).toBe("parent-session-1")
	})

	it("emit omits session.parent_id for non-subagent events even when the env var is set", async () => {
		const { getActiveFerment } = await import("../ferment/index.js")
		vi.mocked(getActiveFerment).mockReturnValue(undefined)
		// KIMCHI_PARENT_SESSION_ID is process-global and set during a subagent run.
		// Events emitted OUTSIDE a subagent run must not be tagged with it — the
		// parent session is not a parent of itself.
		process.env[PARENT_SESSION_ID_ENV_KEY] = "parent-session-1"

		const ctx = new TelemetryContext(makeConfig())
		ctx.emit("test.event", { custom: "value" })
		ctx.flushLogBuffer()

		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrMap = Object.fromEntries(
			body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(
				(a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue],
			),
		)

		expect(attrMap["session.parent_id"]).toBeUndefined()
	})

	it("emitWithIds adds session.parent_id when running inside a subagent", async () => {
		process.env.KIMCHI_SUBAGENT = "1"
		process.env[PARENT_SESSION_ID_ENV_KEY] = "parent-session-2"

		const ctx = new TelemetryContext(makeConfig())
		ctx.emitWithIds("ferment.started", { ferment_id: "ferment-1" })
		ctx.flushLogBuffer()

		await Promise.allSettled([...ctx.inFlight])

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const attrMap = Object.fromEntries(
			body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(
				(a: { key: string; value: { stringValue: string } }) => [a.key, a.value.stringValue],
			),
		)

		expect(attrMap["session.parent_id"]).toBe("parent-session-2")
	})

	it("getParentSessionId returns the env value only inside a subagent run", () => {
		const ctx = new TelemetryContext(makeConfig())
		process.env.KIMCHI_SUBAGENT = "1"
		process.env[PARENT_SESSION_ID_ENV_KEY] = "parent-session-1"
		expect(ctx.getParentSessionId()).toBe("parent-session-1")

		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		expect(ctx.getParentSessionId()).toBeUndefined()
	})

	it("resolveSessionId falls back to telemetryId before a pi session id is set", () => {
		const ctx = new TelemetryContext(makeConfig())
		expect(ctx.resolveSessionId()).toBe(ctx.telemetryId)
	})

	it("resolveSessionId returns the pi session id once set", () => {
		const ctx = new TelemetryContext(makeConfig())
		ctx.setPiSessionId("019e2af0-153f-77dc-839c-683e23fd301d")
		expect(ctx.resolveSessionId()).toBe("019e2af0-153f-77dc-839c-683e23fd301d")
	})

	it("setPiSessionId treats an empty id as unset so resolveSessionId falls back", () => {
		const ctx = new TelemetryContext(makeConfig())
		ctx.setPiSessionId("session-aaa")
		ctx.setPiSessionId("")
		expect(ctx.piSessionId).toBeUndefined()
		expect(ctx.resolveSessionId()).toBe(ctx.telemetryId)
	})

	it("emitted events use the pi session id as session.id once set", async () => {
		const ctx = new TelemetryContext(makeConfig())
		ctx.setPiSessionId("019e2af0-153f-77dc-839c-683e23fd301d")
		ctx.emit("test.event", { custom: "value" })
		ctx.flushLogBuffer()
		await Promise.allSettled([...ctx.inFlight])

		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
		const attrMap = Object.fromEntries(
			record.attributes.map((a: { key: string; value: { stringValue?: string } }) => [a.key, a.value.stringValue]),
		)
		expect(attrMap["session.id"]).toBe("019e2af0-153f-77dc-839c-683e23fd301d")
	})

	it("flushMetrics stamps the pi session id as session.id on metric data points", async () => {
		const ctx = new TelemetryContext(makeConfig())
		ctx.setPiSessionId("019e2af0-153f-77dc-839c-683e23fd301d")
		ctx.cumulative.tokensByModel.m1 = { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 }

		ctx.flushMetrics()
		await Promise.allSettled([...ctx.inFlight])

		const metricsCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]: unknown[]) =>
			String(url).includes("/metrics"),
		)
		expect(metricsCalls.length).toBe(1)
		const body = JSON.parse((metricsCalls[0][1] as { body: string }).body)
		const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics
		expect(metrics.length).toBeGreaterThan(0)
		for (const metric of metrics) {
			const dataPoint = (metric.sum ?? metric.gauge).dataPoints[0]
			const sessionAttr = dataPoint.attributes.find((a: { key: string }) => a.key === "session.id")
			expect(sessionAttr?.value.stringValue).toBe("019e2af0-153f-77dc-839c-683e23fd301d")
		}
	})

	it("accumulators stay keyed by telemetryId even when pi session ids differ", () => {
		const ctx1 = new TelemetryContext(makeConfig())
		const ctx2 = new TelemetryContext(makeConfig())
		ctx1.setPiSessionId("session-aaa")
		ctx2.setPiSessionId("session-bbb")
		expect(ctx1.cumulative).toBe(ctx2.cumulative)
	})

	it("reset() keeps telemetryId keying and does not throw before a pi session id exists", () => {
		const ctx = new TelemetryContext(makeConfig())
		expect(() => ctx.reset()).not.toThrow()
		expect(ctx.resolveSessionId()).toBe(ctx.telemetryId)
	})

	it("handleSessionStart captures the pi session id from ctx", async () => {
		const { handleSessionStart } = await import("./handlers/session.js")
		const tm = new TelemetryContext(makeConfig())
		const ctx = createContext({
			sessionManager: { getSessionId: () => "019e2af0-153f-77dc-839c-683e23fd301d" },
			model: { id: "m" },
		})
		handleSessionStart(tm, ctx)
		expect(tm.resolveSessionId()).toBe("019e2af0-153f-77dc-839c-683e23fd301d")
	})

	it("handleSessionStart ignores an empty session id (keeps telemetryId fallback)", async () => {
		const { handleSessionStart } = await import("./handlers/session.js")
		const tm = new TelemetryContext(makeConfig())
		const ctx = createContext({ sessionManager: { getSessionId: () => "" }, model: { id: "m" } })
		handleSessionStart(tm, ctx)
		expect(tm.resolveSessionId()).toBe(tm.telemetryId)
	})

	it("handleSessionStart re-capture on fork/resume overwrites the previous session id", async () => {
		const { handleSessionStart } = await import("./handlers/session.js")
		const tm = new TelemetryContext(makeConfig())
		const original = createContext({
			sessionManager: { getSessionId: () => "019e2af0-153f-77dc-839c-683e23fd301d" },
			model: { id: "m" },
		})
		const forked = createContext({
			sessionManager: { getSessionId: () => "019e2af1-26d4-7f9e-8b0c-1a2b3c4d5e6f" },
			model: { id: "m" },
		})
		handleSessionStart(tm, original)
		handleSessionStart(tm, forked)
		expect(tm.resolveSessionId()).toBe("019e2af1-26d4-7f9e-8b0c-1a2b3c4d5e6f")
	})
})
