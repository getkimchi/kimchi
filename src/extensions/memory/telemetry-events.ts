/**
 * Content-free telemetry facts emitted by persistent memory. Live events use a
 * single per-session pi.events channel; short-lived capture workers send the
 * same bounded summaries through pre-session telemetry instead.
 *
 * Privacy is a source-side invariant: payloads contain only closed enums,
 * booleans, durations, and counts. Never add fact/query text, fact or project
 * IDs, paths, tool arguments/results, or raw errors to these contracts.
 */

export const MEMORY_TELEMETRY_CHANNEL = "memory:telemetry"

export type MemorySessionStateReason = "initial" | "toggle"
export type MemoryCaptureScheduleOutcome = "enqueued" | "coalesced" | "deferred" | "already_captured" | "failed"
export type MemoryCaptureSpawnOutcome = "started" | "failed"
export type MemoryCaptureWaveOutcome = "completed" | "partial" | "deferred"
export type MemoryCaptureFailureClass = "startup" | "watchdog" | "drain" | "unknown"
export type MemoryRecallKind = "digest_init" | "digest_progressive"
export type MemoryRecallTrigger = "before_agent_start" | "user_turn" | "step_budget" | "state_revisit"
export type MemoryRecallOutcome =
	| "delivered"
	| "no_hits"
	| "covered"
	| "gate_skip"
	| "no_searcher"
	| "failed"
	| "cancelled"
	| "timed_out"
	| "dropped_stale"
export type MemoryRecallDelivery = "attached" | "steered" | "none"
export type MemoryGateStatus = "not_run" | "passed" | "skipped" | "degraded"
export type MemoryToolName = "memory_search" | "save_memory"
export type MemorySearchOutcome = "hits" | "no_hits" | "disabled" | "failed"
export type MemorySaveOutcome = "saved" | "duplicate" | "too_short" | "too_long" | "disabled" | "failed"

export interface MemorySessionStateTelemetry {
	event: "session_state"
	active: boolean
	authoredEnabled: boolean
	reason: MemorySessionStateReason
}

export interface MemoryCaptureScheduleTelemetry {
	event: "capture.schedule"
	outcome: MemoryCaptureScheduleOutcome
	messageCount: number
	pendingCount: number
	oldestPendingMs?: number
}

export interface MemoryCaptureSpawnTelemetry {
	event: "capture.spawn"
	outcome: MemoryCaptureSpawnOutcome
}

export interface MemoryRecallCompositionTelemetry {
	searchCount?: number
	consideredCount?: number
	selectedCount?: number
	deliveredCount?: number
	belowThresholdCount?: number
	selectorSkippedCount?: number
	overCapCount?: number
	overBudgetCount?: number
	estimatedTokens?: number
}

export interface MemoryRecallTelemetry extends MemoryRecallCompositionTelemetry {
	event: "recall.completed"
	kind: MemoryRecallKind
	trigger: MemoryRecallTrigger
	outcome: MemoryRecallOutcome
	delivery: MemoryRecallDelivery
	gateStatus: MemoryGateStatus
	durationMs: number
}

interface MemoryToolTelemetryBase {
	durationMs: number
	retrievedCount: number
	returnedCount: number
}

export type MemoryToolTelemetry =
	| (MemoryToolTelemetryBase & {
			event: "tool.completed"
			tool: "memory_search"
			outcome: MemorySearchOutcome
	  })
	| (MemoryToolTelemetryBase & {
			event: "tool.completed"
			tool: "save_memory"
			outcome: MemorySaveOutcome
	  })

export type MemoryLiveTelemetryEvent =
	| MemorySessionStateTelemetry
	| MemoryCaptureScheduleTelemetry
	| MemoryCaptureSpawnTelemetry
	| MemoryRecallTelemetry
	| MemoryToolTelemetry

export interface MemoryCaptureWaveTelemetry {
	event: "capture.wave"
	outcome: MemoryCaptureWaveOutcome
	durationMs: number
	jobCount: number
	storedCount: number
	triagedWindowCount: number
	nonDurableCount: number
	valuationDiscardCount: number
	redactedCount: number
	oversizedCount: number
	failedJobCount: number
	addQuarantinedCount: number
	poisonQuarantinedCount: number
	pendingCount: number
	oldestPendingMs?: number
}

export interface MemoryCaptureFailedTelemetry {
	event: "capture.failed"
	failureClass: MemoryCaptureFailureClass
	durationMs: number
}

export type MemoryWorkerTelemetryEvent = MemoryCaptureWaveTelemetry | MemoryCaptureFailedTelemetry
export type MemoryTelemetryEvent = MemoryLiveTelemetryEvent | MemoryWorkerTelemetryEvent

export type MemoryTelemetryReporter = (event: MemoryLiveTelemetryEvent) => void
export type MemoryTelemetryPublish = (channel: string, event: MemoryLiveTelemetryEvent) => void

/** Create a fail-open, per-runtime publisher. Publish failures warn once and
 * never propagate into capture, recall, or tools. */
export function createMemoryTelemetryReporter(publish: MemoryTelemetryPublish): MemoryTelemetryReporter {
	let warned = false
	return (event) => {
		try {
			publish(MEMORY_TELEMETRY_CHANNEL, event)
		} catch (err) {
			if (warned) return
			warned = true
			console.warn(
				"[memory] telemetry publication failed; continuing without memory telemetry:",
				err instanceof Error ? err.message : err,
			)
		}
	}
}

/** Convert a bounded worker summary to primitive properties for
 * sendPreSessionEvent. That helper adds the `event.` wire prefix itself. */
export function memoryWorkerTelemetryProperties(
	event: MemoryWorkerTelemetryEvent,
): Record<string, string | number | boolean> {
	if (event.event === "capture.failed") {
		return { failure_class: event.failureClass, duration_ms: event.durationMs }
	}
	return {
		outcome: event.outcome,
		duration_ms: event.durationMs,
		job_count: event.jobCount,
		stored_count: event.storedCount,
		triaged_window_count: event.triagedWindowCount,
		non_durable_count: event.nonDurableCount,
		valuation_discard_count: event.valuationDiscardCount,
		redacted_count: event.redactedCount,
		oversized_count: event.oversizedCount,
		failed_job_count: event.failedJobCount,
		add_quarantined_count: event.addQuarantinedCount,
		poison_quarantined_count: event.poisonQuarantinedCount,
		pending_count: event.pendingCount,
		...(event.oldestPendingMs === undefined ? {} : { oldest_pending_ms: event.oldestPendingMs }),
	}
}
