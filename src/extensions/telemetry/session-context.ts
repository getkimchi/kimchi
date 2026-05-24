import crypto from "node:crypto"
import type { TelemetryConfig } from "../../config.js"
import { type CumulativeState, collectMetrics, createCumulativeState } from "./accumulator.js"
import { toAttrs } from "./helpers.js"
import { type LogRecord, buildLogRecord, sendLogBatch, sendMetrics } from "./transport.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TELEMETRY_DRAIN_TIMEOUT_MS = 5_000
export const METRICS_FLUSH_INTERVAL_MS = 30_000
export const LOG_BATCH_FLUSH_INTERVAL_MS = 5_000
export const LOG_BATCH_MAX_SIZE = 20

// ---------------------------------------------------------------------------
// SessionContext — per-session telemetry state
// ---------------------------------------------------------------------------

export class SessionContext {
	config: TelemetryConfig
	sessionId: string
	sessionStartMs: number
	sessionStartNano: string
	source: string
	mode: string

	currentModel = "unknown"
	sentMessages = new Set<string>()
	pendingArgs = new Map<string, { toolName: string; args: unknown }>()
	messageStartTimes = new Map<string, number>()
	cumulative: CumulativeState = createCumulativeState()
	inFlight = new Set<Promise<void>>()
	shuttingDown = false
	flushTimer: NodeJS.Timeout | undefined
	logBuffer: LogRecord[] = []
	private logFlushTimer: NodeJS.Timeout | undefined

	constructor(config: TelemetryConfig, source: string, mode: string) {
		this.config = config
		this.source = source
		this.mode = mode
		this.sessionId = crypto.randomUUID()
		this.sessionStartMs = Date.now()
		this.sessionStartNano = String(this.sessionStartMs * 1_000_000)
	}

	reset(source: string, mode: string): void {
		this.source = source
		this.mode = mode
		this.sessionId = crypto.randomUUID()
		this.sessionStartMs = Date.now()
		this.sessionStartNano = String(this.sessionStartMs * 1_000_000)
		this.currentModel = "unknown"
		this.sentMessages.clear()
		this.pendingArgs.clear()
		this.messageStartTimes.clear()
		this.cumulative = createCumulativeState()
		this.inFlight.clear()
		this.shuttingDown = false
		this.logBuffer = []
		this.stopLogFlushTimer()
	}

	track(p: Promise<void>): void {
		if (this.shuttingDown) return
		this.inFlight.add(p)
		p.finally(() => this.inFlight.delete(p))
	}

	emit(eventName: string, attrs: Record<string, string | number | boolean>): void {
		const merged = { ...attrs, source: this.source, mode: this.mode }
		this.logBuffer.push(buildLogRecord(this.sessionId, eventName, toAttrs(merged)))
		if (this.logBuffer.length >= LOG_BATCH_MAX_SIZE) {
			this.flushLogBuffer()
		} else if (this.logFlushTimer === undefined) {
			this.logFlushTimer = setTimeout(() => this.flushLogBuffer(), LOG_BATCH_FLUSH_INTERVAL_MS)
		}
	}

	flushLogBuffer(): void {
		this.stopLogFlushTimer()
		if (this.logBuffer.length === 0) return
		const records = this.logBuffer.splice(0)
		this.track(sendLogBatch(this.config, records))
	}

	private stopLogFlushTimer(): void {
		if (this.logFlushTimer !== undefined) {
			clearTimeout(this.logFlushTimer)
			this.logFlushTimer = undefined
		}
	}

	flushMetrics(): void {
		const metrics = collectMetrics(this.cumulative)
		if (metrics.length > 0) {
			this.track(sendMetrics(this.config, this.sessionId, metrics, this.sessionStartNano))
		}
	}

	startFlushTimer(): void {
		this.stopFlushTimer()
		this.flushTimer = setInterval(() => this.flushMetrics(), METRICS_FLUSH_INTERVAL_MS)
	}

	stopFlushTimer(): void {
		if (this.flushTimer !== undefined) {
			clearInterval(this.flushTimer)
			this.flushTimer = undefined
		}
	}

	async drain(): Promise<void> {
		this.messageStartTimes.clear()
		this.stopFlushTimer()
		this.flushLogBuffer()
		this.flushMetrics()
		this.shuttingDown = true
		if (this.inFlight.size > 0) {
			await Promise.race([
				Promise.allSettled([...this.inFlight]),
				new Promise<void>((resolve) => setTimeout(resolve, TELEMETRY_DRAIN_TIMEOUT_MS)),
			])
		}
	}
}
