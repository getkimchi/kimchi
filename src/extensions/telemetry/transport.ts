import type { TelemetryConfig } from "../../config.js"
import { getVersion } from "../../utils.js"
import { nowNano, strAttr } from "./helpers.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AttrValue = { stringValue: string } | { intValue: string } | { doubleValue: number }

export interface LogRecord {
	timeUnixNano: string
	observedTimeUnixNano: string
	severityNumber: number
	severityText: string
	eventName: string
	body: { stringValue: string }
	attributes: Array<{ key: string; value: AttrValue }>
	droppedAttributesCount: number
	flags: number
	traceId: string
	spanId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resourceAttributes() {
	return [strAttr("service.name", "kimchi"), strAttr("user_agent.original", `kimchi/${getVersion()}`)]
}

function attr(key: string, value: string | number): { key: string; value: AttrValue } {
	if (typeof value === "number") {
		return Number.isInteger(value)
			? { key, value: { intValue: String(value) } }
			: { key, value: { doubleValue: value } }
	}
	return { key, value: { stringValue: value } }
}

export interface MetricData {
	name: string
	type: "Sum" | "Gauge"
	value: number
	attrs: Record<string, string | number>
}

// ---------------------------------------------------------------------------
// OTLP transport
// ---------------------------------------------------------------------------

export async function sendLog(
	config: TelemetryConfig,
	sessionId: string,
	eventName: string,
	attrs: Record<string, string | number>,
	userEmail?: string,
): Promise<void> {
	if (!config.enabled || !config.endpoint) return
	const now = nowNano()
	const payload: Record<string, unknown> = {
		resourceLogs: [
			{
				resource: { attributes: resourceAttributes(), droppedAttributesCount: 0 },
				scopeLogs: [
					{
						scope: { name: "kimchi", version: "1.0.0" },
						logRecords: [
							{
								timeUnixNano: now,
								observedTimeUnixNano: now,
								severityNumber: 9,
								severityText: "INFO",
								eventName,
								body: { stringValue: eventName },
								attributes: [
									strAttr("session.id", sessionId),
									strAttr("client", "pi"),
									...Object.entries(attrs).map(([k, v]) => strAttr(k, String(v))),
								],
								droppedAttributesCount: 0,
								flags: 0,
								traceId: "",
								spanId: "",
							},
						],
					},
				],
			},
		],
	}
	if (userEmail) payload.userEmail = userEmail
	try {
		await fetch(config.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...config.headers },
			body: JSON.stringify(payload),
		})
	} catch (err) {
		// telemetry is best effort, noop on failure
	}
}

export function buildLogRecord(
	sessionId: string,
	eventName: string,
	attrs: Record<string, string | number>,
): LogRecord {
	const now = nowNano()
	return {
		timeUnixNano: now,
		observedTimeUnixNano: now,
		severityNumber: 9,
		severityText: "INFO",
		eventName,
		body: { stringValue: eventName },
		attributes: [
			strAttr("session.id", sessionId),
			strAttr("client", "pi"),
			...Object.entries(attrs).map(([k, v]) => strAttr(k, String(v))),
		],
		droppedAttributesCount: 0,
		flags: 0,
		traceId: "",
		spanId: "",
	}
}

export async function sendLogBatch(config: TelemetryConfig, records: LogRecord[], userEmail?: string): Promise<void> {
	if (!config.enabled || !config.endpoint || records.length === 0) return
	const payload: Record<string, unknown> = {
		resourceLogs: [
			{
				resource: { attributes: resourceAttributes(), droppedAttributesCount: 0 },
				scopeLogs: [
					{
						scope: { name: "kimchi", version: "1.0.0" },
						logRecords: records,
					},
				],
			},
		],
	}
	if (userEmail) payload.userEmail = userEmail
	try {
		await fetch(config.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...config.headers },
			body: JSON.stringify(payload),
		})
	} catch (err) {
		// telemetry is best effort, noop on failure
	}
}

export async function sendMetrics(
	config: TelemetryConfig,
	sessionId: string,
	metrics: MetricData[],
	sessionStartNano: string,
	userEmail?: string,
): Promise<void> {
	if (!config.enabled || !config.metricsEndpoint || metrics.length === 0) return
	const now = nowNano()
	const payload: Record<string, unknown> = {
		resourceMetrics: [
			{
				resource: { attributes: resourceAttributes(), droppedAttributesCount: 0 },
				scopeMetrics: [
					{
						scope: { name: "kimchi", version: "1.0.0" },
						metrics: metrics.map((m) => ({
							name: m.name,
							[m.type.toLowerCase() as "sum" | "gauge"]: {
								dataPoints: [
									{
										timeUnixNano: now,
										startTimeUnixNano: sessionStartNano,
										...(Number.isInteger(m.value) ? { asInt: String(m.value) } : { asDouble: m.value }),
										attributes: [
											strAttr("session.id", sessionId),
											strAttr("client", "pi"),
											...Object.entries(m.attrs).map(([k, v]) => strAttr(k, String(v))),
										],
									},
								],
								...(m.type === "Sum" ? { aggregationTemporality: 2, isMonotonic: true } : {}),
							},
						})),
					},
				],
			},
		],
	}
	if (userEmail) payload.userEmail = userEmail
	try {
		await fetch(config.metricsEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...config.headers },
			body: JSON.stringify(payload),
		})
	} catch (err) {
		// telemetry is best effort, noop on failure
	}
}
