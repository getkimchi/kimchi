import type { ExtensionAPI, TurnStartEvent } from "@earendil-works/pi-coding-agent"
import type { TelemetryConfig } from "../../config.js"
import { onBeforeProviderHeaders } from "../../types/before-provider-headers.js"
import {
	BASH_TOOL_GUARD_EVENTS,
	type BashToolGuardAllowedByUserRequestPayload,
	type BashToolGuardBlockPayload,
	type BashToolGuardWarnPayload,
} from "../bash-tool-guard-events.js"
import {
	FERMENT_EVENTS,
	type FermentAbandonedPayload,
	type FermentCompletedPayload,
	type FermentPhaseCompletedPayload,
	type FermentPhaseStartedPayload,
	type FermentStalledPayload,
	type FermentStartedPayload,
	type FermentSteeringPayload,
	type FermentStepCompletedPayload,
	type FermentStepFailedPayload,
	type FermentStepStartedPayload,
} from "../ferment/domain-events.js"

import { handleAgentEnd, handleBeforeAgentStart, handleMessageEnd, handleMessageStart } from "./handlers/messages.js"
import { emitSessionStartEvent, handleSessionInitialized, handleSessionShutdown } from "./handlers/session.js"
import { handleToolExecutionEnd, handleToolExecutionStart } from "./handlers/tools.js"
import { SessionContext } from "./session-context.js"
import {
	type SurveyAnsweredTelemetry,
	type SurveyDismissedTelemetry,
	type SurveyShownTelemetry,
	emitSurveyAnswered,
	emitSurveyDismissed,
	emitSurveyShown,
} from "./survey.js"

// ---------------------------------------------------------------------------
// Module-level state for ferment lifecycle tracking
// ---------------------------------------------------------------------------

/**
 * Snapshot of cumulative token/cost counters at a point in time.
 * Used to compute per-phase deltas: capture at phase activation,
 * diff at phase completion. Best-effort — inaccurate during true-parallel
 * phases that share the same process-level accumulators.
 */
export interface TokenSnapshot {
	inputByModel: Record<string, number>
	outputByModel: Record<string, number>
}

/** Snapshot taken at phase activation, keyed by "${fermentId}:${phaseId}". */
const phaseTokenSnapshots = new Map<string, TokenSnapshot>()

/**
 * Running sum of phase token/cost deltas, keyed by fermentId.
 * Accumulated as each phase completes. Used for ferment.completed totals.
 * This is more reliable than diffing the session accumulator at ferment
 * start/end: the session may include scoping-conversation tokens that
 * accumulate before phases begin, making the start-snapshot too large.
 */
const fermentTokenTotals = new Map<string, { input: number; output: number }>()

/** Wall-clock ms at ferment creation, keyed by fermentId. */
const fermentStartTimes = new Map<string, number>()

/**
 * Wall-clock ms at phase activation, keyed by "${fermentId}:${phaseId}".
 */
const phaseStartTimes = new Map<string, number>()

/**
 * Wall-clock ms at step start, keyed by "${fermentId}:${phaseId}:${stepId}".
 * Composite key avoids collisions across phases that reuse the same step index.
 */
const stepStartTimes = new Map<string, number>()

/** User steering interaction count during a ferment, keyed by fermentId. */
const fermentSteeringCounts = new Map<string, number>()

/**
 * Steering count snapshot at phase activation, keyed by "${fermentId}:${phaseId}".
 * Used to compute per-phase steering delta.
 */
const phaseSteeringSnapshots = new Map<string, number>()

/**
 * Steering count snapshot at step start, keyed by "${fermentId}:${phaseId}:${stepId}".
 * Used to compute per-step steering delta.
 */
const stepSteeringSnapshots = new Map<string, number>()

/** @internal — exposed for testing only */
export function _resetFermentTrackingState(): void {
	phaseTokenSnapshots.clear()
	fermentTokenTotals.clear()
	fermentStartTimes.clear()
	phaseStartTimes.clear()
	stepStartTimes.clear()
	fermentSteeringCounts.clear()
	phaseSteeringSnapshots.clear()
	stepSteeringSnapshots.clear()
}

/** @internal — exposed for testing only */
export function _getBashGuardCounts(): { warn: number; block: number; allowedByUserRequest: number } {
	return { ...bashGuardCounts }
}

// ---------------------------------------------------------------------------
// Shared telemetry context (set during extension init)
// ---------------------------------------------------------------------------

let _ctx: SessionContext | undefined
let _telemetryConfig: TelemetryConfig = { enabled: false, endpoint: "", metricsEndpoint: "", headers: {}, apiKey: "" }
let sessionStartEmitted = false

export { _telemetryConfig }

function isEnabled(): boolean {
	return !!(_ctx && _telemetryConfig.enabled && _telemetryConfig.endpoint)
}

// ---------------------------------------------------------------------------
// Token snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Capture the current cumulative token/cost counters for a phase.
 * Called at phase activation via the ferment:phase_started domain event.
 */
function captureSnapshot(ctx: SessionContext): TokenSnapshot {
	const { tokensByModel } = ctx.cumulative
	const snapshot: TokenSnapshot = { inputByModel: {}, outputByModel: {} }
	for (const [model, t] of Object.entries(tokensByModel)) {
		snapshot.inputByModel[model] = t.input
		snapshot.outputByModel[model] = t.output
	}
	return snapshot
}

function diffSnapshot(ctx: SessionContext, snapshot: TokenSnapshot): { deltaInput: number; deltaOutput: number } {
	const { tokensByModel } = ctx.cumulative
	let deltaInput = 0
	let deltaOutput = 0
	for (const [model, t] of Object.entries(tokensByModel)) {
		deltaInput += t.input - (snapshot.inputByModel[model] ?? 0)
		deltaOutput += t.output - (snapshot.outputByModel[model] ?? 0)
	}
	return {
		deltaInput: Math.max(0, deltaInput),
		deltaOutput: Math.max(0, deltaOutput),
	}
}

export function snapshotPhaseTokens(fermentId: string, phaseId: string): void {
	if (!_ctx) return
	phaseTokenSnapshots.set(`${fermentId}:${phaseId}`, captureSnapshot(_ctx))
}

/**
 * Compute the token/cost delta since the snapshot taken at phase activation.
 * Removes the snapshot. Returns zeros when no snapshot exists.
 */
export function consumePhaseTokenDelta(
	fermentId: string,
	phaseId: string,
): { deltaInput: number; deltaOutput: number } {
	const key = `${fermentId}:${phaseId}`
	const snapshot = phaseTokenSnapshots.get(key)
	phaseTokenSnapshots.delete(key)
	if (!_ctx || !snapshot) return { deltaInput: 0, deltaOutput: 0 }
	return diffSnapshot(_ctx, snapshot)
}

// ---------------------------------------------------------------------------
// Existing track* functions
// ---------------------------------------------------------------------------

export async function trackSubagentSpawned(args: { id: string; type: string; description: string }): Promise<void> {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	ctx.emit("subagent.spawned", { model: ctx.currentModel, agent_type: args.type, reason: args.description })
}

export function trackSurveyShown(args: SurveyShownTelemetry): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	emitSurveyShown(ctx, args)
}

export function trackSurveyAnswered(args: SurveyAnsweredTelemetry): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	emitSurveyAnswered(ctx, args)
}

export function trackSurveyDismissed(args: SurveyDismissedTelemetry): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	emitSurveyDismissed(ctx, args)
}

// ---------------------------------------------------------------------------
// Ferment domain event handlers (subscribed via pi.events)
// ---------------------------------------------------------------------------

function cleanupFermentState(fermentId: string): void {
	fermentStartTimes.delete(fermentId)
	fermentTokenTotals.delete(fermentId)
	fermentSteeringCounts.delete(fermentId)
	for (const key of phaseTokenSnapshots.keys()) {
		if (key.startsWith(`${fermentId}:`)) phaseTokenSnapshots.delete(key)
	}
	for (const key of phaseStartTimes.keys()) {
		if (key.startsWith(`${fermentId}:`)) phaseStartTimes.delete(key)
	}
	for (const key of stepStartTimes.keys()) {
		if (key.startsWith(`${fermentId}:`)) stepStartTimes.delete(key)
	}
	for (const key of phaseSteeringSnapshots.keys()) {
		if (key.startsWith(`${fermentId}:`)) phaseSteeringSnapshots.delete(key)
	}
	for (const key of stepSteeringSnapshots.keys()) {
		if (key.startsWith(`${fermentId}:`)) stepSteeringSnapshots.delete(key)
	}
}

function onFermentStarted(raw: unknown): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as FermentStartedPayload
	fermentStartTimes.set(payload.fermentId, Date.now())
	// Initialise the running phase-delta accumulator. Totals are summed as
	// each phase completes rather than diffing the session accumulator at
	// ferment start/end (which over-counts scoping-conversation tokens).
	fermentTokenTotals.set(payload.fermentId, { input: 0, output: 0 })
	ctx.emitWithIds(
		"ferment.started",
		{ ferment_id: payload.fermentId },
		{ ferment_name: payload.name, phase_count: payload.phaseCount, model: ctx.currentModel },
	)
}

function onFermentCompleted(raw: unknown): void {
	const payload = raw as FermentCompletedPayload
	// Read all tracking state BEFORE cleanup — cleanupFermentState deletes the
	// maps, so lookups after it return undefined.
	const startMs = fermentStartTimes.get(payload.fermentId) ?? 0
	const durationMs = startMs > 0 ? Date.now() - startMs : 0
	const steeringCount = fermentSteeringCounts.get(payload.fermentId) ?? 0
	const totals = fermentTokenTotals.get(payload.fermentId) ?? { input: 0, output: 0 }
	// Clean up all tracking state unconditionally — steering counts accumulate
	// regardless of whether telemetry is enabled, so cleanup must always run.
	cleanupFermentState(payload.fermentId)
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return

	// Totals are the sum of per-phase deltas accumulated in onPhaseCompleted.
	// Using phase-delta sums (rather than a session-accumulator diff) avoids
	// counting scoping-conversation tokens that occur before phases start.
	const totalInput = totals.input
	const totalOutput = totals.output

	const attrs: Record<string, string | number | boolean> = {
		ferment_name: payload.name,
		phase_count: payload.phaseCount,
		duration_ms: durationMs,
		total_input_tokens: totalInput,
		total_output_tokens: totalOutput,
		steering_count: steeringCount,
		block_retries: payload.blockRetries,
		model: ctx.currentModel,
	}
	if (payload.grade) attrs.grade = payload.grade
	ctx.emitWithIds("ferment.completed", { ferment_id: payload.fermentId }, attrs)
}

function onFermentAbandoned(raw: unknown): void {
	const payload = raw as FermentAbandonedPayload
	// Read steering count BEFORE cleanup — cleanupFermentState deletes it.
	const steeringCount = fermentSteeringCounts.get(payload.fermentId) ?? 0
	// Clean up unconditionally — steering counts accumulate regardless of enabled state.
	cleanupFermentState(payload.fermentId)
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const attrs: Record<string, string | number | boolean> = {
		ferment_name: payload.name,
		model: ctx.currentModel,
		lifecycle_stage: payload.lifecycleStage,
		scoping_complete: payload.scopingComplete,
		completed_phases: payload.completedPhases,
		total_phases: payload.totalPhases,
		phase_completion_ratio: payload.phaseCompletionRatio,
		step_failure_count: payload.stepFailureCount,
		duration_ms: payload.durationMs,
		steering_count: steeringCount,
	}
	if (payload.reason) attrs.reason = payload.reason
	if (payload.lastActivePhaseIndex !== undefined) attrs.last_active_phase_index = payload.lastActivePhaseIndex
	ctx.emitWithIds("ferment.abandoned", { ferment_id: payload.fermentId }, attrs)
}

function onFermentStalled(raw: unknown): void {
	const payload = raw as FermentStalledPayload
	// No per-ferment Maps to clean up for stalled — ferment remains accessible.
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const attrs: Record<string, string | number | boolean> = {
		ferment_name: payload.name,
		model: ctx.currentModel,
		lifecycle_stage: payload.lifecycleStage,
		idle_duration_ms: payload.idleDurationMs,
		completed_phases: payload.completedPhases,
		total_phases: payload.totalPhases,
		phase_completion_ratio: payload.phaseCompletionRatio,
	}
	ctx.emitWithIds("ferment.stalled", { ferment_id: payload.fermentId }, attrs)
}

function onPhaseStarted(raw: unknown): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as FermentPhaseStartedPayload
	const phaseKey = `${payload.fermentId}:${payload.phaseId}`
	phaseStartTimes.set(phaseKey, Date.now())
	phaseSteeringSnapshots.set(phaseKey, fermentSteeringCounts.get(payload.fermentId) ?? 0)
	snapshotPhaseTokens(payload.fermentId, payload.phaseId)
	ctx.emitWithIds(
		"ferment.phase.started",
		{ ferment_id: payload.fermentId, phase_id: payload.phaseId },
		{ phase_index: payload.phaseIndex, phase_name: payload.phaseName, model: ctx.currentModel },
	)
}

function onPhaseCompleted(raw: unknown): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as FermentPhaseCompletedPayload
	const phaseKey = `${payload.fermentId}:${payload.phaseId}`
	const phaseStartMs = phaseStartTimes.get(phaseKey) ?? 0
	phaseStartTimes.delete(phaseKey)
	const steeringAtStart = phaseSteeringSnapshots.get(phaseKey) ?? 0
	phaseSteeringSnapshots.delete(phaseKey)
	const steeringCount = (fermentSteeringCounts.get(payload.fermentId) ?? 0) - steeringAtStart
	const { deltaInput, deltaOutput } = consumePhaseTokenDelta(payload.fermentId, payload.phaseId)
	// Accumulate into the ferment-level running total.
	const ft = fermentTokenTotals.get(payload.fermentId)
	if (ft) {
		ft.input += deltaInput
		ft.output += deltaOutput
	}
	const attrs: Record<string, string | number | boolean> = {
		phase_index: payload.phaseIndex,
		phase_name: payload.phaseName,
		duration_ms: phaseStartMs > 0 ? Date.now() - phaseStartMs : 0,
		delta_input_tokens: deltaInput,
		delta_output_tokens: deltaOutput,
		block_retries: payload.blockRetries,
		steering_count: steeringCount,
		model: ctx.currentModel,
	}
	if (payload.grade) attrs.grade = payload.grade
	ctx.emitWithIds("ferment.phase.completed", { ferment_id: payload.fermentId, phase_id: payload.phaseId }, attrs)
}

function onStepStarted(raw: unknown): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as FermentStepStartedPayload
	const key = `${payload.fermentId}:${payload.phaseId}:${payload.stepId}`
	stepStartTimes.set(key, Date.now())
	stepSteeringSnapshots.set(key, fermentSteeringCounts.get(payload.fermentId) ?? 0)
	ctx.emitWithIds(
		"ferment.step.started",
		{ ferment_id: payload.fermentId, phase_id: payload.phaseId, step_id: payload.stepId },
		{ step_index: payload.stepIndex, model: ctx.currentModel },
	)
}

function onStepCompleted(raw: unknown): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as FermentStepCompletedPayload
	const key = `${payload.fermentId}:${payload.phaseId}:${payload.stepId}`
	const startMs = stepStartTimes.get(key) ?? Date.now()
	stepStartTimes.delete(key)
	const steeringAtStart = stepSteeringSnapshots.get(key) ?? 0
	stepSteeringSnapshots.delete(key)
	const steeringCount = (fermentSteeringCounts.get(payload.fermentId) ?? 0) - steeringAtStart
	const attrs: Record<string, string | number | boolean> = {
		step_index: payload.stepIndex,
		duration_ms: Date.now() - startMs,
		success: payload.success,
		steering_count: steeringCount,
		model: ctx.currentModel,
	}
	if (payload.grade) attrs.grade = payload.grade
	ctx.emitWithIds(
		"ferment.step.completed",
		{ ferment_id: payload.fermentId, phase_id: payload.phaseId, step_id: payload.stepId },
		attrs,
	)
}

function onStepFailed(raw: unknown): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as FermentStepFailedPayload
	const key = `${payload.fermentId}:${payload.phaseId}:${payload.stepId}`
	stepStartTimes.delete(key)
	const attrs: Record<string, string | number | boolean> = {
		step_index: payload.stepIndex,
		model: ctx.currentModel,
	}
	if (payload.reason) attrs.reason = payload.reason.slice(0, 300)
	ctx.emitWithIds(
		"ferment.step.failed",
		{ ferment_id: payload.fermentId, phase_id: payload.phaseId, step_id: payload.stepId },
		attrs,
	)
}

function onFermentSteering(raw: unknown): void {
	// Accumulate regardless of telemetry enabled — count is emitted at
	// ferment.completed / ferment.abandoned which are gated on isEnabled().
	const payload = raw as FermentSteeringPayload
	const current = fermentSteeringCounts.get(payload.fermentId) ?? 0
	fermentSteeringCounts.set(payload.fermentId, current + 1)
}

// ---------------------------------------------------------------------------
// Bash-tool-guard domain event handlers
// ---------------------------------------------------------------------------

/** Module-level accumulators for bash-tool-guard counters. Per-session. */
const bashGuardCounts = {
	warn: 0,
	block: 0,
	allowedByUserRequest: 0,
}

function resetBashGuardCounts(): void {
	bashGuardCounts.warn = 0
	bashGuardCounts.block = 0
	bashGuardCounts.allowedByUserRequest = 0
}

function onBashGuardWarn(raw: unknown): void {
	bashGuardCounts.warn++
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as BashToolGuardWarnPayload
	// Only structured fields land in OTLP. Raw command text is
	// intentionally NOT emitted to avoid leaking user data or secrets
	// that may appear inside heredocs, echo payloads, or sed/awk
	// replacement strings. Aggregation is done by category + tool.
	ctx.emit("bash_tool_guard.warn", {
		model: ctx.currentModel,
		category: payload.category,
		tool: payload.tool,
		count: payload.count,
	})
}

function onBashGuardBlock(raw: unknown): void {
	bashGuardCounts.block++
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as BashToolGuardBlockPayload
	ctx.emit("bash_tool_guard.block", {
		model: ctx.currentModel,
		category: payload.category,
		tool: payload.tool,
		count: payload.count,
	})
}

function onBashGuardAllowedByUserRequest(raw: unknown): void {
	bashGuardCounts.allowedByUserRequest++
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as BashToolGuardAllowedByUserRequestPayload
	ctx.emit("bash_tool_guard.allowed_by_user_request", {
		model: ctx.currentModel,
		category: payload.category,
		tool: payload.tool,
	})
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function telemetryExtension(config: TelemetryConfig) {
	_telemetryConfig = config
	return (pi: ExtensionAPI) => {
		if (!config.enabled) return

		const ctx = new SessionContext(config, "cli")
		_ctx = ctx

		// Subscribe to ferment domain events published via pi.events.
		// This keeps telemetry decoupled from ferment internals — ferment
		// publishes facts; telemetry translates them into OTLP records.
		pi.events.on(FERMENT_EVENTS.STARTED, onFermentStarted)
		pi.events.on(FERMENT_EVENTS.COMPLETED, onFermentCompleted)
		pi.events.on(FERMENT_EVENTS.ABANDONED, onFermentAbandoned)
		pi.events.on(FERMENT_EVENTS.STALLED, onFermentStalled)
		pi.events.on(FERMENT_EVENTS.PHASE_STARTED, onPhaseStarted)
		pi.events.on(FERMENT_EVENTS.PHASE_COMPLETED, onPhaseCompleted)
		pi.events.on(FERMENT_EVENTS.STEP_STARTED, onStepStarted)
		pi.events.on(FERMENT_EVENTS.STEP_COMPLETED, onStepCompleted)
		pi.events.on(FERMENT_EVENTS.STEP_FAILED, onStepFailed)
		pi.events.on(FERMENT_EVENTS.STEERING, onFermentSteering)

		// Subscribe to bash-tool-guard domain events. The guard publishes
		// facts; telemetry translates them into OTLP records for analytics.
		pi.events.on(BASH_TOOL_GUARD_EVENTS.WARN, onBashGuardWarn)
		pi.events.on(BASH_TOOL_GUARD_EVENTS.BLOCK, onBashGuardBlock)
		pi.events.on(BASH_TOOL_GUARD_EVENTS.ALLOWED_BY_USER_REQUEST, onBashGuardAllowedByUserRequest)

		pi.on("session_start", async (_event, extCtx) => {
			resetBashGuardCounts()
			const modelId = (extCtx as { model?: { id?: string } } | undefined)?.model?.id
			handleSessionInitialized(ctx, modelId)
		})
		pi.on("session_shutdown", async (event) => handleSessionShutdown(ctx, event as { reason?: string }))
		pi.on("message_start", async (event) =>
			handleMessageStart(ctx, event as { message: { role: string; responseId?: string; timestamp?: number } }),
		)
		pi.on("message_end", async (event) =>
			handleMessageEnd(ctx, event as unknown as { message: Record<string, unknown> }),
		)
		pi.on("model_select", async (event) => {
			const e = event as { model?: { id?: string } }
			ctx.currentModel = e.model?.id ?? "unknown"
		})
		pi.on("session_compact", async () => {
			ctx.compactionCount++
			ctx.emit("session.compacted", {
				model: ctx.currentModel,
				compaction_count: ctx.compactionCount,
				turn_index: ctx.turnIndex,
			})
		})
		pi.on("tool_execution_start", async (event) =>
			handleToolExecutionStart(ctx, event as { toolCallId: string; toolName: string; args: unknown }),
		)
		pi.on("tool_execution_end", async (event) => {
			handleToolExecutionEnd(ctx, event as { toolCallId: string; isError?: boolean; result?: unknown })
		})
		pi.on("before_agent_start", async (event, extCtx) => {
			if (!sessionStartEmitted) {
				sessionStartEmitted = true
				emitSessionStartEvent(ctx)
			}
			if (ctx.currentModel === "unknown") {
				const modelId = (extCtx as { model?: { id?: string } } | undefined)?.model?.id
				if (modelId) ctx.currentModel = modelId
			}
			const e = event as { prompt: string }
			handleBeforeAgentStart(ctx, e)
		})
		pi.on("agent_end", async (event) => {
			handleAgentEnd(ctx, event as { messages?: { role?: string; content?: unknown[] }[] })
		})
		pi.on("turn_start", async (event) => {
			const incoming = (event as TurnStartEvent).turnIndex
			if (incoming !== undefined) {
				ctx.turnIndex = incoming
			} else {
				console.warn("[telemetry] turn_start received without turnIndex field — ctx.turnIndex unchanged")
			}
		})
		onBeforeProviderHeaders(pi, (event) => ({
			...event.headers,
			"X-Session-Id": ctx.sessionId,
			// 0 means "before first turn" (sentinel); backend should treat it accordingly.
			"X-Turn-Index": String(ctx.turnIndex),
		}))
	}
}
