import * as fs from "node:fs"
import * as path from "node:path"
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

const DEBUG_FLAG = process.env.KIMCHI_TELEMETRY_DEBUG

function logEventToFile(event: string, properties: Record<string, unknown>): void {
	if (!DEBUG_FLAG) return
	try {
		const logDir = path.join(process.cwd(), ".kimchi")
		fs.mkdirSync(logDir, { recursive: true })
		const entry = `${JSON.stringify({ timestamp: new Date().toISOString(), event, properties })}\n`
		fs.appendFileSync(path.join(logDir, "telemetry-debug.log"), entry)
	} catch {
		// silently ignore debug logging failures
	}
}

function resourceAttributes() {
	return [strAttr("service.name", "kimchi"), strAttr("user_agent.original", `kimchi/${getVersion()}`)]
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
	const record = buildLogRecord(sessionId, eventName, attrs)
	await sendLogBatch(config, [record], userEmail)
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
	for (const record of records) {
		const props = Object.fromEntries(
			record.attributes.map((a) => {
				const v = a.value as Record<string, unknown>
				return [a.key, v.stringValue ?? v.intValue ?? v.doubleValue]
			}),
		)
		logEventToFile(record.eventName, props)
	}
	try {
		const response = await fetch(config.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...config.headers },
			body: JSON.stringify(payload),
		})
		if (!response.ok) {
			logEventToFile("telemetry.response.error", {
				endpoint: config.endpoint,
				status: response.status,
				statusText: response.statusText,
				recordCount: records.length,
			})
		}
	} catch (err) {
		logEventToFile("telemetry.request.error", {
			endpoint: config.endpoint,
			error: String(err),
			recordCount: records.length,
		})
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
	for (const metric of metrics) {
		logEventToFile(metric.name, { value: metric.value, ...metric.attrs })
	}
	try {
		const response = await fetch(config.metricsEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...config.headers },
			body: JSON.stringify(payload),
		})
		if (!response.ok) {
			logEventToFile("telemetry.response.error", {
				endpoint: config.metricsEndpoint,
				status: response.status,
				statusText: response.statusText,
				metricCount: metrics.length,
			})
		}
	} catch (err) {
		logEventToFile("telemetry.request.error", {
			endpoint: config.metricsEndpoint,
			error: String(err),
			metricCount: metrics.length,
		})
	}
}
