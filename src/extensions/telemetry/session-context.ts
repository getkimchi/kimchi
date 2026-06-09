import crypto from "node:crypto"
import { getMe } from "../../api/me.js"
import type { TelemetryConfig } from "../../config.js"
import { getActiveFerment } from "../ferment/index.js"
import { type CumulativeState, collectMetrics, createCumulativeState } from "./accumulator.js"
import { toAttrs } from "./helpers.js"
import { getSessionType } from "./session-type.js"
import { type LogRecord, buildLogRecord, sendLogBatch, sendMetrics } from "./transport.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TELEMETRY_DRAIN_TIMEOUT_MS = 5_000
export const METRICS_FLUSH_INTERVAL_MS = 30_000
export const LOG_BATCH_FLUSH_INTERVAL_MS = 5_000
export const LOG_BATCH_MAX_SIZE = 20

// ---------------------------------------------------------------------------
// Process-level root session ID + shared accumulators
//
// All agents (main + sub-agents) in the same process share rootSessionId so
// that telemetry rolls up under one session in the backend.
//
// Accumulators are keyed by rootSessionId (not per-instance) so that every
// flush sends the monotonically increasing total across ALL agents. This is
// required because the backend uses ReplacingMergeTree: rows with the same
// ORDER BY key are deduplicated and the latest write wins.
// ---------------------------------------------------------------------------

let rootSessionId: string | undefined
const sharedAccumulators = new Map<string, CumulativeState>()

function getOrCreateAccumulator(sessionId: string): CumulativeState {
	let acc = sharedAccumulators.get(sessionId)
	if (!acc) {
		acc = createCumulativeState()
		sharedAccumulators.set(sessionId, acc)
	}
	return acc
}

/** @internal — exposed for testing only */
export function _resetSharedAccumulators(): void {
	if (rootSessionId) sharedAccumulators.delete(rootSessionId)
	rootSessionId = undefined
}

// ---------------------------------------------------------------------------
// SessionContext — per-session telemetry state
// ---------------------------------------------------------------------------

export class SessionContext {
	config: TelemetryConfig
	sessionId: string
	sessionStartMs: number
	source: string
	currentModel = "unknown"
	sentMessages = new Set<string>()
	pendingArgs = new Map<string, { toolName: string; args: unknown }>()
	messageStartTimes = new Map<string, number>()
	toolStartTimes = new Map<string, number>()
	cumulative: CumulativeState
	inFlight = new Set<Promise<void>>()
	shuttingDown = false
	flushTimer: NodeJS.Timeout | undefined
	logBuffer: LogRecord[] = []
	private logFlushTimer: NodeJS.Timeout | undefined
	lastSessionType: string | undefined

	/** Cached user email from /v1/me — populated once in the background. */
	userEmail: string | undefined
	/** Resolves when the userEmail has been fetched (or the fetch failed). */
	userEmailReady: Promise<void>
	private resolveUserEmailReady!: () => void

	constructor(config: TelemetryConfig, source: string) {
		this.config = config
		this.source = source
		if (!rootSessionId) rootSessionId = crypto.randomUUID()
		this.sessionId = rootSessionId
		this.sessionStartMs = Date.now()
		this.cumulative = getOrCreateAccumulator(this.sessionId)
		this.userEmailReady = new Promise<void>((resolve) => {
			this.resolveUserEmailReady = resolve
		})
		this.fetchUserEmail()
	}

	get sessionStartNano(): string {
		return this.cumulative.sessionStartNano
	}

	reset(source: string): void {
		this.source = source
		if (!rootSessionId) rootSessionId = crypto.randomUUID()
		this.sessionId = rootSessionId
		this.sessionStartMs = Date.now()
		this.currentModel = "unknown"
		this.sentMessages.clear()
		this.pendingArgs.clear()
		this.messageStartTimes.clear()
		this.toolStartTimes.clear()
		this.lastSessionType = undefined
		this.cumulative = getOrCreateAccumulator(this.sessionId)
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

	/**
	 * Emit a ferment lifecycle event with explicit identifiers that cannot be
	 * clobbered by the auto-inject in `emit()`.
	 *
	 * Use this for all ferment.* events where the active ferment may already
	 * have been cleared by the time the event fires (e.g. ferment.completed
	 * fires after runtime.setActive(undefined)).
	 *
	 * Deliberately skips the session.type_changed side-effect — that is for
	 * ambient session events, not explicit lifecycle events.
	 */
	emitWithIds(
		eventName: string,
		ids: { ferment_id: string; phase_id?: string; step_id?: string },
		attrs: Record<string, string | number | boolean>,
	): void {
		const sessionType = getSessionType()
		const merged: Record<string, string | number | boolean> = {
			source: this.source,
			session_type: sessionType,
			...ids,
			...attrs,
		}
		this.enqueueLogRecord(buildLogRecord(this.sessionId, eventName, toAttrs(merged)))
	}

	emit(eventName: string, attrs: Record<string, string | number | boolean>): void {
		const sessionType = getSessionType()
		const ferment = getActiveFerment()

		// Detect and emit session.type_changed when the type transitions
		if (this.lastSessionType !== undefined && sessionType !== this.lastSessionType) {
			const changeAttrs = toAttrs({
				session_type: sessionType,
				previous_session_type: this.lastSessionType,
				source: this.source,
				ferment_id: ferment?.id ?? "",
			})
			this.logBuffer.push(buildLogRecord(this.sessionId, "session.type_changed", changeAttrs))
		}
		this.lastSessionType = sessionType

		const merged = { ...attrs, source: this.source, session_type: sessionType, ferment_id: ferment?.id ?? "" }
		this.enqueueLogRecord(buildLogRecord(this.sessionId, eventName, toAttrs(merged)))
	}

	/** Append a pre-built log record to the buffer and schedule/trigger a flush. */
	private enqueueLogRecord(record: LogRecord): void {
		this.logBuffer.push(record)
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
		this.track(this.userEmailReady.then(() => sendLogBatch(this.config, records, this.userEmail)))
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
			this.track(
				this.userEmailReady.then(() =>
					sendMetrics(this.config, this.sessionId, metrics, this.sessionStartNano, this.userEmail),
				),
			)
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

	private fetchUserEmail(): void {
		const { apiKey } = this.config
		if (!apiKey) {
			this.resolveUserEmailReady()
			return
		}
		getMe(apiKey)
			.then((me) => {
				this.userEmail = me.email
			})
			.catch(() => {
				// best effort — telemetry continues without email
			})
			.finally(() => {
				this.resolveUserEmailReady()
			})
	}

	async drain(): Promise<void> {
		this.messageStartTimes.clear()
		this.toolStartTimes.clear()
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
