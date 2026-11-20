/**
 * Translate content-free memory domain events into OTLP log records. Every
 * field is validated and copied explicitly: extra payload properties never
 * reach the wire, even if a producer later adds sensitive data by mistake.
 */
import type { TelemetryAttributes, TelemetryContext } from "../session-context.js"

export const MEMORY_TELEMETRY_RECORDS = {
	SESSION_STATE: "memory.session_state",
	CAPTURE_SCHEDULE: "memory.capture.schedule",
	CAPTURE_SPAWN: "memory.capture.spawn",
	CAPTURE_WAVE: "memory.capture.wave",
	CAPTURE_FAILED: "memory.capture.failed",
	RECALL_COMPLETED: "memory.recall.completed",
	TOOL_COMPLETED: "memory.tool.completed",
} as const

const SESSION_REASONS = ["initial", "toggle"] as const
const SCHEDULE_OUTCOMES = ["enqueued", "coalesced", "deferred", "already_captured", "failed"] as const
const SPAWN_OUTCOMES = ["started", "failed"] as const
const WAVE_OUTCOMES = ["completed", "partial", "deferred"] as const
const FAILURE_CLASSES = ["startup", "watchdog", "drain", "unknown"] as const
const RECALL_KINDS = ["digest_init", "digest_progressive"] as const
const RECALL_TRIGGERS = ["before_agent_start", "user_turn", "step_budget", "state_revisit"] as const
const RECALL_OUTCOMES = [
	"delivered",
	"no_hits",
	"covered",
	"gate_skip",
	"no_searcher",
	"failed",
	"cancelled",
	"timed_out",
	"dropped_stale",
] as const
const DELIVERIES = ["attached", "steered", "none"] as const
const GATE_STATUSES = ["not_run", "passed", "skipped", "degraded"] as const
const SEARCH_OUTCOMES = ["hits", "no_hits", "disabled", "failed"] as const
const SAVE_OUTCOMES = ["saved", "duplicate", "too_short", "too_long", "disabled", "failed"] as const

const RECALL_COUNT_ATTRS = [
	"searchCount",
	"consideredCount",
	"selectedCount",
	"deliveredCount",
	"belowThresholdCount",
	"selectorSkippedCount",
	"overCapCount",
	"overBudgetCount",
	"estimatedTokens",
] as const
const WAVE_COUNT_ATTRS = [
	"durationMs",
	"jobCount",
	"storedCount",
	"triagedWindowCount",
	"nonDurableCount",
	"valuationDiscardCount",
	"redactedCount",
	"oversizedCount",
	"failedJobCount",
	"addQuarantinedCount",
	"poisonQuarantinedCount",
	"pendingCount",
	"oldestPendingMs",
] as const

function asRecord(raw: unknown): Record<string, unknown> | undefined {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
}

function allowed(value: unknown, values: readonly string[]): string | undefined {
	return typeof value === "string" && values.includes(value) ? value : undefined
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined
}

function snakeCase(value: string): string {
	return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

/** Copy only the named optional numeric fields. An invalid present value drops
 * the entire event rather than silently truncating analytics or vocabulary. */
function countAttrs(payload: Record<string, unknown>, names: readonly string[]): TelemetryAttributes | undefined {
	const attrs: TelemetryAttributes = {}
	for (const name of names) {
		const value = payload[name]
		if (value === undefined) continue
		const parsed = count(value)
		if (parsed === undefined) return undefined
		attrs[snakeCase(name)] = parsed
	}
	return attrs
}

function emit(ctx: TelemetryContext, eventName: string, attrs: TelemetryAttributes): void {
	ctx.emit(eventName, { ...attrs, turn_index: ctx.turnIndex }, undefined)
}

function sessionState(ctx: TelemetryContext, payload: Record<string, unknown>): void {
	const active = boolean(payload.active)
	const authoredEnabled = boolean(payload.authoredEnabled)
	const reason = allowed(payload.reason, SESSION_REASONS)
	if (active === undefined || authoredEnabled === undefined || !reason) return
	emit(ctx, MEMORY_TELEMETRY_RECORDS.SESSION_STATE, { active, authored_enabled: authoredEnabled, reason })
}

function captureSchedule(ctx: TelemetryContext, payload: Record<string, unknown>): void {
	const outcome = allowed(payload.outcome, SCHEDULE_OUTCOMES)
	const messageCount = count(payload.messageCount)
	const pendingCount = count(payload.pendingCount)
	const optional = countAttrs(payload, ["oldestPendingMs"])
	if (!outcome || messageCount === undefined || pendingCount === undefined || !optional) return
	emit(ctx, MEMORY_TELEMETRY_RECORDS.CAPTURE_SCHEDULE, {
		outcome,
		message_count: messageCount,
		pending_count: pendingCount,
		...optional,
	})
}

function captureSpawn(ctx: TelemetryContext, payload: Record<string, unknown>): void {
	const outcome = allowed(payload.outcome, SPAWN_OUTCOMES)
	if (outcome) emit(ctx, MEMORY_TELEMETRY_RECORDS.CAPTURE_SPAWN, { outcome })
}

function captureWave(ctx: TelemetryContext, payload: Record<string, unknown>): void {
	const outcome = allowed(payload.outcome, WAVE_OUTCOMES)
	const counts = countAttrs(payload, WAVE_COUNT_ATTRS)
	if (!outcome || !counts) return
	// Unlike optional recall/diagnostic numbers, the wave summary must be whole.
	for (const name of WAVE_COUNT_ATTRS) {
		if (name !== "oldestPendingMs" && payload[name] === undefined) return
	}
	emit(ctx, MEMORY_TELEMETRY_RECORDS.CAPTURE_WAVE, { outcome, ...counts })
}

function captureFailed(ctx: TelemetryContext, payload: Record<string, unknown>): void {
	const failureClass = allowed(payload.failureClass, FAILURE_CLASSES)
	const durationMs = count(payload.durationMs)
	if (!failureClass || durationMs === undefined) return
	emit(ctx, MEMORY_TELEMETRY_RECORDS.CAPTURE_FAILED, { failure_class: failureClass, duration_ms: durationMs })
}

function recallCompleted(ctx: TelemetryContext, payload: Record<string, unknown>): void {
	const kind = allowed(payload.kind, RECALL_KINDS)
	const trigger = allowed(payload.trigger, RECALL_TRIGGERS)
	const outcome = allowed(payload.outcome, RECALL_OUTCOMES)
	const delivery = allowed(payload.delivery, DELIVERIES)
	const gateStatus = allowed(payload.gateStatus, GATE_STATUSES)
	const durationMs = count(payload.durationMs)
	const counts = countAttrs(payload, RECALL_COUNT_ATTRS)
	if (!kind || !trigger || !outcome || !delivery || !gateStatus || durationMs === undefined || !counts) return
	emit(ctx, MEMORY_TELEMETRY_RECORDS.RECALL_COMPLETED, {
		kind,
		trigger,
		outcome,
		delivery,
		gate_status: gateStatus,
		duration_ms: durationMs,
		...counts,
	})
}

function toolCompleted(ctx: TelemetryContext, payload: Record<string, unknown>): void {
	const durationMs = count(payload.durationMs)
	const retrievedCount = count(payload.retrievedCount)
	const returnedCount = count(payload.returnedCount)
	if (durationMs === undefined || retrievedCount === undefined || returnedCount === undefined) return
	if (payload.tool === "memory_search") {
		const outcome = allowed(payload.outcome, SEARCH_OUTCOMES)
		if (!outcome) return
		emit(ctx, MEMORY_TELEMETRY_RECORDS.TOOL_COMPLETED, {
			tool: "memory_search",
			outcome,
			duration_ms: durationMs,
			retrieved_count: retrievedCount,
			returned_count: returnedCount,
		})
		return
	}
	if (payload.tool === "save_memory") {
		const outcome = allowed(payload.outcome, SAVE_OUTCOMES)
		if (!outcome) return
		emit(ctx, MEMORY_TELEMETRY_RECORDS.TOOL_COMPLETED, {
			tool: "save_memory",
			outcome,
			duration_ms: durationMs,
			retrieved_count: retrievedCount,
			returned_count: returnedCount,
		})
	}
}

/** Handle one untrusted bus payload. Unknown or out-of-contract events are
 * ignored without affecting the session or other telemetry records. */
export function handleMemoryTelemetry(ctx: TelemetryContext, raw: unknown): void {
	const payload = asRecord(raw)
	if (!payload) return
	switch (payload.event) {
		case "session_state":
			sessionState(ctx, payload)
			return
		case "capture.schedule":
			captureSchedule(ctx, payload)
			return
		case "capture.spawn":
			captureSpawn(ctx, payload)
			return
		case "capture.wave":
			captureWave(ctx, payload)
			return
		case "capture.failed":
			captureFailed(ctx, payload)
			return
		case "recall.completed":
			recallCompleted(ctx, payload)
			return
		case "tool.completed":
			toolCompleted(ctx, payload)
	}
}
