import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../config.js"
import { buildLogRecord, sendLog, sendLogBatch, sendMetrics } from "./transport.js"
import type { MetricData } from "./transport.js"

const BASE_NS = String(new Date("2026-06-02T10:00:00.000Z").getTime() * 1_000_000)

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

describe("sendLog", () => {
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

	it("sends correct OTLP structure with eventName, session.id, client attributes", async () => {
		const config = makeConfig()
		await sendLog(config, "session-123", "session.start", { source: "cli", count: 1 })

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(url).toBe("https://test.example.com/logs")
		expect(options.method).toBe("POST")
		expect(options.headers["Content-Type"]).toBe("application/json")
		expect(options.headers.Authorization).toBe("Bearer test")

		const body = JSON.parse(options.body)
		expect(body).toHaveProperty("resourceLogs")
		expect(body.resourceLogs).toHaveLength(1)

		const resourceLog = body.resourceLogs[0]
		expect(resourceLog.resource.attributes).toContainEqual({
			key: "service.name",
			value: { stringValue: "kimchi" },
		})

		const logRecord = resourceLog.scopeLogs[0].logRecords[0]
		expect(logRecord.eventName).toBe("session.start")
		expect(logRecord.body).toEqual({ stringValue: "session.start" })
		expect(logRecord.severityNumber).toBe(9)
		expect(logRecord.severityText).toBe("INFO")

		const attrKeys = logRecord.attributes.map((a: { key: string }) => a.key)
		expect(attrKeys).toContain("session.id")
		expect(attrKeys).toContain("client")
		expect(attrKeys).toContain("source")
		expect(attrKeys).toContain("count")

		const sessionAttr = logRecord.attributes.find((a: { key: string }) => a.key === "session.id")
		expect(sessionAttr.value.stringValue).toBe("session-123")

		const clientAttr = logRecord.attributes.find((a: { key: string }) => a.key === "client")
		expect(clientAttr.value.stringValue).toBe("pi")
	})

	it("skips when disabled", async () => {
		const config = makeConfig({ enabled: false })
		await sendLog(config, "session-123", "session.start", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})

	it("skips when endpoint is empty", async () => {
		const config = makeConfig({ endpoint: "" })
		await sendLog(config, "session-123", "session.start", {})
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})

	it("doesn't throw on fetch failure", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"))
		const config = makeConfig()
		await expect(sendLog(config, "session-123", "session.start", {})).resolves.toBeUndefined()
	})

	it("doesn't throw on non-ok response", async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			text: vi.fn().mockResolvedValue("Internal Server Error"),
		} as unknown as Response)
		const config = makeConfig()
		await expect(sendLog(config, "session-123", "session.start", {})).resolves.toBeUndefined()
	})

	it("includes userEmail in payload when provided", async () => {
		const config = makeConfig()
		await sendLog(config, "session-123", "session.start", { source: "cli" }, "alice@test.com")
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		expect(body.userEmail).toBe("alice@test.com")
	})

	it("omits userEmail from payload when not provided", async () => {
		const config = makeConfig()
		await sendLog(config, "session-123", "session.start", {})
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		expect(body.userEmail).toBeUndefined()
	})
})

describe("buildLogRecord", () => {
	it("returns a record with correct eventName and attributes", () => {
		const record = buildLogRecord("sess-1", "file_read", { language: "TypeScript", file_hash: "abc123def456" })
		expect(record.eventName).toBe("file_read")
		expect(record.body.stringValue).toBe("file_read")
		expect(record.severityNumber).toBe(9)
		expect(record.timeUnixNano).toBeTruthy()
		const keys = record.attributes.map((a) => a.key)
		expect(keys).toContain("session.id")
		expect(keys).toContain("client")
		expect(keys).toContain("language")
		expect(keys).toContain("file_hash")
		const sessionAttr = record.attributes.find((a) => a.key === "session.id")
		expect(sessionAttr && "stringValue" in sessionAttr.value ? sessionAttr.value.stringValue : undefined).toBe("sess-1")
	})
})

describe("sendLogBatch", () => {
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

	it("sends multiple records in a single POST", async () => {
		const config = makeConfig()
		const records = [
			buildLogRecord("s1", "file_read", { language: "Go" }),
			buildLogRecord("s1", "tool_result", { tool_name: "read" }),
		]
		await sendLogBatch(config, records)

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		const logRecords = body.resourceLogs[0].scopeLogs[0].logRecords
		expect(logRecords).toHaveLength(2)
		expect(logRecords[0].eventName).toBe("file_read")
		expect(logRecords[1].eventName).toBe("tool_result")
	})

	it("skips when records array is empty", async () => {
		await sendLogBatch(makeConfig(), [])
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})

	it("skips when disabled", async () => {
		const record = buildLogRecord("s1", "test", {})
		await sendLogBatch(makeConfig({ enabled: false }), [record])
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})

	it("doesn't throw on fetch failure", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"))
		const record = buildLogRecord("s1", "test", {})
		await expect(sendLogBatch(makeConfig(), [record])).resolves.toBeUndefined()
	})

	it("includes userEmail in batch payload when provided", async () => {
		const records = [buildLogRecord("s1", "event.a", {})]
		await sendLogBatch(makeConfig(), records, "bob@test.com")
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		expect(body.userEmail).toBe("bob@test.com")
	})

	it("omits userEmail from batch payload when not provided", async () => {
		const records = [buildLogRecord("s1", "event.a", {})]
		await sendLogBatch(makeConfig(), records)
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		expect(body.userEmail).toBeUndefined()
	})
})

describe("sendMetrics", () => {
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

	it("sends correct OTLP metrics structure with Sum type, isMonotonic, asInt", async () => {
		const config = makeConfig()
		const metrics: MetricData[] = [
			{
				name: "claude_code.token.usage",
				type: "Sum",
				value: 100,
				attrs: { model: "claude-3-5-sonnet", type: "input" },
			},
		]
		await sendMetrics(config, "session-abc", metrics, BASE_NS)

		expect(globalThis.fetch).toHaveBeenCalledOnce()
		const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(url).toBe("https://test.example.com/metrics")
		expect(options.method).toBe("POST")

		const body = JSON.parse(options.body)
		expect(body).toHaveProperty("resourceMetrics")
		expect(body.resourceMetrics).toHaveLength(1)

		const resourceMetric = body.resourceMetrics[0]
		expect(resourceMetric.resource.attributes).toContainEqual({
			key: "service.name",
			value: { stringValue: "kimchi" },
		})

		const metric = resourceMetric.scopeMetrics[0].metrics[0]
		expect(metric.name).toBe("claude_code.token.usage")
		expect(metric).toHaveProperty("sum")
		expect(metric.sum.aggregationTemporality).toBe(2)
		expect(metric.sum.isMonotonic).toBe(true)

		const dataPoint = metric.sum.dataPoints[0]
		expect(dataPoint.asInt).toBe("100")
		expect(dataPoint.startTimeUnixNano).toBe(BASE_NS)

		const attrKeys = dataPoint.attributes.map((a: { key: string }) => a.key)
		expect(attrKeys).toContain("session.id")
		expect(attrKeys).toContain("client")
		expect(attrKeys).toContain("model")

		const sessionAttr = dataPoint.attributes.find((a: { key: string }) => a.key === "session.id")
		expect(sessionAttr.value.stringValue).toBe("session-abc")
	})

	it("skips when metrics array is empty", async () => {
		const config = makeConfig()
		await sendMetrics(config, "session-abc", [], BASE_NS)
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})

	it("skips when metricsEndpoint is empty", async () => {
		const config = makeConfig({ metricsEndpoint: "" })
		const metrics: MetricData[] = [{ name: "claude_code.token.usage", type: "Sum", value: 100, attrs: {} }]
		await sendMetrics(config, "session-abc", metrics, BASE_NS)
		expect(globalThis.fetch).not.toHaveBeenCalled()
	})

	it("includes userEmail in metrics payload when provided", async () => {
		const metrics: MetricData[] = [{ name: "claude_code.token.usage", type: "Sum", value: 50, attrs: {} }]
		await sendMetrics(makeConfig(), "session-abc", metrics, BASE_NS, "carol@test.com")
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		expect(body.userEmail).toBe("carol@test.com")
	})

	it("omits userEmail from metrics payload when not provided", async () => {
		const metrics: MetricData[] = [{ name: "claude_code.token.usage", type: "Sum", value: 50, attrs: {} }]
		await sendMetrics(makeConfig(), "session-abc", metrics, BASE_NS)
		const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
		const body = JSON.parse(options.body)
		expect(body.userEmail).toBeUndefined()
	})
})
