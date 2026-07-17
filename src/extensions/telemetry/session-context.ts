import crypto from "node:crypto"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getMe } from "../../api/me.js"
import type { TelemetryConfig } from "../../config.js"
import { IS_ACP_MODE } from "../../modes/acp/state.js"
import { getOsMetadata } from "../../utils/os-metadata.js"
import { getActiveFerment } from "../ferment/index.js"
import { type CumulativeState, collectMetrics, createCumulativeState } from "./accumulator.js"
import { getAcpAttributes, getPiSessionAttributes } from "./handlers/utils.js"
import { toAttrs } from "./helpers.js"
import { getSessionType } from "./session-type.js"
import { buildLogRecord, type LogRecord, sendLogBatch, sendMetrics } from "./transport.js"

export type TelemetryAttributes = Record<string, string | number | boolean>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TELEMETRY_DRAIN_TIMEOUT_MS = 5_000
export const METRICS_FLUSH_INTERVAL_MS = 30_000
export const LOG_BATCH_FLUSH_INTERVAL_MS = 5_000
export const LOG_BATCH_MAX_SIZE = 20

// ---------------------------------------------------------------------------
// Process-level ID + shared accumulators
//
// All agents (main + sub-agents) in the same process share processId so
// that telemetry rolls up under one session in the backend.
//
// Accumulators are keyed by processId (not per-session) so that every
// flush sends the monotonically increasing total across ALL agents. This is
// required because the backend uses ReplacingMergeTree: rows with the same
// ORDER BY key are deduplicated and the latest write wins.
// ---------------------------------------------------------------------------

let processId: string | undefined
const sharedAccumulators = new Map<string, CumulativeState>()

function getOrCreateAccumulator(processId: string): CumulativeState {
	let acc = sharedAccumulators.get(processId)
	if (!acc) {
		acc = createCumulativeState()
		sharedAccumulators.set(processId, acc)
	}
	return acc
}

/** @internal — exposed for testing only */
export function _resetSharedAccumulators(): void {
	if (processId) sharedAccumulators.delete(processId)
	processId = undefined
}

// ---------------------------------------------------------------------------
// SessionContext — process-level telemetry state
// ---------------------------------------------------------------------------

export class TelemetryContext {
	config: TelemetryConfig
	processId: string
	processStartMs: number
	/**
	 * Current model, updated from message events; used for domain events that lack a pi context.
	 */
	currentModel = "unknown"
	/**
	 * Current turn index, updated on each turn_start event.
	 * `0` is a sentinel meaning "before the first turn" (e.g. a provider call
	 * made during session warmup before any user message). Backends should treat
	 * `0` as "unknown / pre-turn" rather than a valid 1-based turn number.
	 */
	turnIndex = 0
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
	/** Number of context compactions in the current session. */
	compactionCount = 0
	/** Cached OS metadata — computed once per SessionContext instance. */
	private osMetadata: ReturnType<typeof getOsMetadata>

	/** Cached user email from /v1/me — populated once in the background. */
	userEmail: string | undefined
	/** Cached user ID (uuid) from /v1/me — populated once in the background. */
	userId: string | undefined
	/** Resolves when the userEmail has been fetched (or the fetch failed). */
	userEmailReady: Promise<void>
	private resolveUserEmailReady!: () => void

	constructor(config: TelemetryConfig) {
		this.config = config
		this.osMetadata = getOsMetadata()
		if (!processId) processId = crypto.randomUUID()
		this.processId = processId
		this.processStartMs = Date.now()
		this.cumulative = getOrCreateAccumulator(this.processId)
		this.userEmailReady = new Promise<void>((resolve) => {
			this.resolveUserEmailReady = resolve
		})
		this.fetchUserEmail()
	}

	get sessionStartNano(): string {
		return this.cumulative.sessionStartNano
	}

	reset(): void {
		if (!processId) processId = crypto.randomUUID()
		this.processId = processId
		this.processStartMs = Date.now()
		this.currentModel = "unknown"
		this.turnIndex = 0
		this.sentMessages.clear()
		this.pendingArgs.clear()
		this.messageStartTimes.clear()
		this.toolStartTimes.clear()
		this.lastSessionType = undefined
		this.compactionCount = 0
		this.cumulative = getOrCreateAccumulator(this.processId)
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
		attrs: TelemetryAttributes & { ferment_id: string; phase_id?: string; step_id?: string },
		ctx?: ExtensionContext,
	): void {
		const { session_type, source, ...commonAttrs } = this.getCommonAttributes(ctx)
		const merged: TelemetryAttributes = {
			session_type,
			source,
			...this.osMetadata,
			...attrs,
			"user.account_uuid": this.userId ?? "",
			...commonAttrs,
		}
		this.enqueueLogRecord(buildLogRecord(this.processId, eventName, toAttrs(merged)))
	}

	emit(eventName: string, attrs?: TelemetryAttributes, ctx?: ExtensionContext): void {
		const ferment = getActiveFerment()
		const { session_type, source, ...commonAttrs } = this.getCommonAttributes(ctx)

		// Detect and emit session.type_changed when the type transitions
		if (this.lastSessionType !== undefined && session_type !== this.lastSessionType) {
			const changeAttrs = toAttrs({
				session_type,
				previous_session_type: this.lastSessionType,
				source,
				ferment_id: ferment?.id ?? "",
			})
			this.logBuffer.push(buildLogRecord(this.processId, "session.type_changed", changeAttrs))
		}
		this.lastSessionType = session_type

		const merged: TelemetryAttributes = {
			...attrs,
			...this.osMetadata,
			session_type,
			source,
			ferment_id: ferment?.id ?? "",
			"user.account_uuid": this.userId ?? "",
			...commonAttrs,
		}
		this.enqueueLogRecord(buildLogRecord(this.processId, eventName, toAttrs(merged)))
	}

	private getCommonAttributes(
		ctx?: ExtensionContext,
	): TelemetryAttributes & { session_type: "ferment" | "coding"; source: "cli" | "acp"; model: string } {
		return {
			session_type: getSessionType(),
			source: IS_ACP_MODE ? "acp" : "cli",
			model: this.currentModel,
			...getAcpAttributes(),
			...(ctx ? getPiSessionAttributes(ctx) : {}),
		}
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
					sendMetrics(
						this.config,
						this.processId,
						metrics.map((m) => ({
							...m,
							attrs: {
								...m.attrs,
								"user.account_uuid": this.userId ?? "",
							},
						})),
						this.sessionStartNano,
					),
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
				this.userId = me.id
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
