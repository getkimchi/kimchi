import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { TelemetryConfig } from "../../config.js"
import {
	FERMENT_EVENTS,
	type FermentAbandonedPayload,
	type FermentCompletedPayload,
	type FermentPhaseCompletedPayload,
	type FermentPhaseStartedPayload,
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
	costByModel: Record<string, number>
}

/** Snapshot taken at phase activation, keyed by "${fermentId}:${phaseId}". */
const phaseTokenSnapshots = new Map<string, TokenSnapshot>()

/**
 * Snapshot taken at ferment creation, keyed by fermentId.
 * Used to compute total token/cost delta for ferment.completed.
 */
const fermentTokenSnapshots = new Map<string, TokenSnapshot>()

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

/** @internal — exposed for testing only */
export function _resetFermentTrackingState(): void {
	phaseTokenSnapshots.clear()
	fermentTokenSnapshots.clear()
	fermentStartTimes.clear()
	phaseStartTimes.clear()
	stepStartTimes.clear()
	fermentSteeringCounts.clear()
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
	const { tokensByModel, costByModel } = ctx.cumulative
	const snapshot: TokenSnapshot = { inputByModel: {}, outputByModel: {}, costByModel: {} }
	for (const [model, t] of Object.entries(tokensByModel)) {
		snapshot.inputByModel[model] = t.input
		snapshot.outputByModel[model] = t.output
	}
	for (const [model, cost] of Object.entries(costByModel)) {
		snapshot.costByModel[model] = cost
	}
	return snapshot
}

function diffSnapshot(
	ctx: SessionContext,
	snapshot: TokenSnapshot,
): { deltaInput: number; deltaOutput: number; deltaCost: number } {
	const { tokensByModel, costByModel } = ctx.cumulative
	let deltaInput = 0
	let deltaOutput = 0
	let deltaCost = 0
	for (const [model, t] of Object.entries(tokensByModel)) {
		deltaInput += t.input - (snapshot.inputByModel[model] ?? 0)
		deltaOutput += t.output - (snapshot.outputByModel[model] ?? 0)
	}
	for (const [model, cost] of Object.entries(costByModel)) {
		deltaCost += cost - (snapshot.costByModel[model] ?? 0)
	}
	return {
		deltaInput: Math.max(0, deltaInput),
		deltaOutput: Math.max(0, deltaOutput),
		deltaCost: Math.max(0, deltaCost),
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
): { deltaInput: number; deltaOutput: number; deltaCost: number } {
	const key = `${fermentId}:${phaseId}`
	const snapshot = phaseTokenSnapshots.get(key)
	phaseTokenSnapshots.delete(key)
	if (!_ctx || !snapshot) return { deltaInput: 0, deltaOutput: 0, deltaCost: 0 }
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

function onFermentStarted(raw: unknown): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as FermentStartedPayload
	fermentStartTimes.set(payload.fermentId, Date.now())
	fermentTokenSnapshots.set(payload.fermentId, captureSnapshot(ctx))
	ctx.emitWithIds(
		"ferment.started",
		{ ferment_id: payload.fermentId },
		{ ferment_name: payload.name, phase_count: payload.phaseCount, model: ctx.currentModel },
	)
}

function onFermentCompleted(raw: unknown): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as FermentCompletedPayload
	const startMs = fermentStartTimes.get(payload.fermentId) ?? 0
	const durationMs = startMs > 0 ? Date.now() - startMs : 0
	const steeringCount = fermentSteeringCounts.get(payload.fermentId) ?? 0

	// Compute total token/cost by diffing the snapshot taken at ferment.started.
	// Phase snapshots are consumed per-phase at phase.completed — any still
	// present here belong to skipped/failed/abandoned phases and are cleaned up.
	const fermentSnapshot = fermentTokenSnapshots.get(payload.fermentId)
	const {
		deltaInput: totalInput,
		deltaOutput: totalOutput,
		deltaCost: totalCost,
	} = fermentSnapshot && ctx ? diffSnapshot(ctx, fermentSnapshot) : { deltaInput: 0, deltaOutput: 0, deltaCost: 0 }

	// Clean up all tracking state for this ferment
	fermentStartTimes.delete(payload.fermentId)
	fermentTokenSnapshots.delete(payload.fermentId)
	fermentSteeringCounts.delete(payload.fermentId)
	// Discard any orphaned tracking state from skipped/failed phases and steps
	for (const key of phaseTokenSnapshots.keys()) {
		if (key.startsWith(`${payload.fermentId}:`)) phaseTokenSnapshots.delete(key)
	}
	for (const key of phaseStartTimes.keys()) {
		if (key.startsWith(`${payload.fermentId}:`)) phaseStartTimes.delete(key)
	}
	for (const key of stepStartTimes.keys()) {
		if (key.startsWith(`${payload.fermentId}:`)) stepStartTimes.delete(key)
	}

	const attrs: Record<string, string | number | boolean> = {
		ferment_name: payload.name,
		phase_count: payload.phaseCount,
		duration_ms: durationMs,
		total_input_tokens: totalInput,
		total_output_tokens: totalOutput,
		total_cost_usd: totalCost,
		steering_count: steeringCount,
		block_retries: payload.blockRetries,
		model: ctx.currentModel,
	}
	if (payload.grade) attrs.grade = payload.grade
	ctx.emitWithIds("ferment.completed", { ferment_id: payload.fermentId }, attrs)
}

function onFermentAbandoned(raw: unknown): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as FermentAbandonedPayload
	fermentStartTimes.delete(payload.fermentId)
	fermentTokenSnapshots.delete(payload.fermentId)
	fermentSteeringCounts.delete(payload.fermentId)
	for (const key of phaseTokenSnapshots.keys()) {
		if (key.startsWith(`${payload.fermentId}:`)) phaseTokenSnapshots.delete(key)
	}
	for (const key of phaseStartTimes.keys()) {
		if (key.startsWith(`${payload.fermentId}:`)) phaseStartTimes.delete(key)
	}
	for (const key of stepStartTimes.keys()) {
		if (key.startsWith(`${payload.fermentId}:`)) stepStartTimes.delete(key)
	}
	const attrs: Record<string, string | number | boolean> = {
		ferment_name: payload.name,
		model: ctx.currentModel,
	}
	if (payload.reason) attrs.reason = payload.reason
	ctx.emitWithIds("ferment.abandoned", { ferment_id: payload.fermentId }, attrs)
}

function onPhaseStarted(raw: unknown): void {
	if (!isEnabled()) return
	const ctx = _ctx
	if (!ctx) return
	const payload = raw as FermentPhaseStartedPayload
	const phaseKey = `${payload.fermentId}:${payload.phaseId}`
	phaseStartTimes.set(phaseKey, Date.now())
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
	const { deltaInput, deltaOutput, deltaCost } = consumePhaseTokenDelta(payload.fermentId, payload.phaseId)
	const attrs: Record<string, string | number | boolean> = {
		phase_index: payload.phaseIndex,
		phase_name: payload.phaseName,
		duration_ms: phaseStartMs > 0 ? Date.now() - phaseStartMs : 0,
		delta_input_tokens: deltaInput,
		delta_output_tokens: deltaOutput,
		delta_cost_usd: deltaCost,
		block_retries: payload.blockRetries,
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
	const attrs: Record<string, string | number | boolean> = {
		step_index: payload.stepIndex,
		duration_ms: Date.now() - startMs,
		success: payload.success,
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
		pi.events.on(FERMENT_EVENTS.PHASE_STARTED, onPhaseStarted)
		pi.events.on(FERMENT_EVENTS.PHASE_COMPLETED, onPhaseCompleted)
		pi.events.on(FERMENT_EVENTS.STEP_STARTED, onStepStarted)
		pi.events.on(FERMENT_EVENTS.STEP_COMPLETED, onStepCompleted)
		pi.events.on(FERMENT_EVENTS.STEP_FAILED, onStepFailed)
		pi.events.on(FERMENT_EVENTS.STEERING, onFermentSteering)

		pi.on("session_start", async (_event, extCtx) => {
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
	}
}
