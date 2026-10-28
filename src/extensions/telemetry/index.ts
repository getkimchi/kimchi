import { randomBytes, randomUUID } from "node:crypto"

import type { Message } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TelemetryConfig } from "../../config.js"
import { SUBAGENT_BASH_CLAMP_EVENTS, type SubagentBashClampedPayload } from "../agents/subagent-bash-clamp-events.js"
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
	type FermentScopingCompletedPayload,
	type FermentScopingResumedPayload,
	type FermentStalledPayload,
	type FermentStartedPayload,
	type FermentSteeringPayload,
	type FermentStepCompletedPayload,
	type FermentStepFailedPayload,
	type FermentStepStartedPayload,
	type UserUnblockedPayload,
} from "../ferment/domain-events.js"
import {
	FERMENT_V2_EVENTS,
	type FermentV2ContextChangedPayload,
	type FermentV2EvaluatedPayload,
	type FermentV2EventName,
	type FermentV2LifecyclePayload,
} from "../ferment-v2/domain-events.js"
import {
	LOOP_GUARD_EVENTS,
	type LoopGuardSubagentAbortPayload,
	type LoopGuardWarnPayload,
} from "../loop-guard-events.js"
import { PERMISSION_EVENTS, type PermissionToolDecisionPayload } from "../permissions/permissions-events.js"
import { STEER_EVENTS } from "../steer-events.js"
import type { TelemetryFermentV2Context } from "./ferment-v2-context.js"
import { handleAgentEnd, handleBeforeAgentStart, handleMessageEnd, handleMessageStart } from "./handlers/messages.js"
import { handleToolDecision } from "./handlers/permissions.js"
import {
	emitSessionStartEvent,
	handleSessionCompact,
	handleSessionShutdown,
	handleSessionStart,
} from "./handlers/session.js"
import { handleSteerAborted, handleSteerFired, handleSteerOutcome } from "./handlers/steers.js"
import { handleToolExecutionEnd, handleToolExecutionStart } from "./handlers/tools.js"
import { handleWorkflowEvent } from "./handlers/workflows.js"
import { TELEMETRY_PROVIDER_HEADER_NAMES } from "./provider-headers.js"
import { type TelemetryAttributes, TelemetryContext } from "./session-context.js"
import { startSettingsChangeWatcher } from "./settings-change-emitter.js"
import {
	emitSurveyAnswered,
	emitSurveyDismissed,
	emitSurveyShown,
	type SurveyAnsweredTelemetry,
	type SurveyDismissedTelemetry,
	type SurveyShownTelemetry,
} from "./survey.js"
import { cleanupFermentTrackingEntries, resetFermentTrackingState, type TokenSnapshot } from "./tracking-state.js"
import { WORKFLOW_TELEMETRY_CHANNEL } from "./workflow-events.js"

// ---------------------------------------------------------------------------
// Shared telemetry context (set during extension init)
// ---------------------------------------------------------------------------

let _telemetryCtx: TelemetryContext | undefined

/** @internal — exposed for testing only */
export function _getTelemetryCtx(): TelemetryContext | undefined {
	return _telemetryCtx
}

/**
 * Live instances keyed by their bound pi session id (registered at
 * session_start, removed at session_shutdown). Session-scoped emissions from
 * outside this module (track* helpers and sibling consumers) resolve the
 * ORIGINATING session's instance through this registry instead of the
 * last-initialized global — with concurrent ACP sessions and in-process
 * subagents, the global can point at a different session than the one
 * producing the event. A lookup for an unknown/unbound session id falls back
 * to the global, preserving the pre-registry behavior for emissions that
 * happen before session_start (e.g. early track* calls).
 */
const sessionRegistry = new Map<string, TelemetryContext>()

function registerSessionContext(sessionId: string | undefined, ctx: TelemetryContext): void {
	if (sessionId) sessionRegistry.set(sessionId, ctx)
}

function unregisterSessionContext(sessionId: string | undefined): void {
	if (sessionId) sessionRegistry.delete(sessionId)
}

/**
 * Resolve the telemetry instance for a session id. Registered instances win;
 * otherwise the last-initialized global (pre-session emissions, legacy
 * callers). NOT a parent/child stack — concurrent sessions and children can
 * finish out of order, so identity-keyed lookup replaces nesting entirely.
 */
export function resolveSessionTelemetryCtx(sessionId: string | undefined): TelemetryContext | undefined {
	if (sessionId !== undefined) {
		const registered = sessionRegistry.get(sessionId)
		if (registered !== undefined) return registered
	}
	return _telemetryCtx
}

/** Enablement check for a specific instance's effective configuration. */
function isCtxEnabled(ctx: TelemetryContext | undefined): ctx is TelemetryContext {
	return !!ctx && ctx.config.enabled && !!ctx.config.endpoint
}

/**
 * @internal — exposed for sibling telemetry modules (e.g. trackFeedback).
 * Mirrors the instance `isCtxEnabled` check against the last-initialized
 * global. Session-scoped emitters should resolve their instance via
 * {@link resolveSessionTelemetryCtx} instead.
 */
export function _isTelemetryEnabled(): boolean {
	return isCtxEnabled(_telemetryCtx)
}

/**
 * @internal — exposed for testing only. Resets the ferment tracking state
 * of the last-initialized instance (tests construct a fresh instance per
 * test via the factory, so that instance is the one under test). The
 * ferment v2 enrichment context is instance-scoped now, so it resets the
 * same instance's field — not any process-global.
 */
export function _resetFermentTrackingState(): void {
	const ctx = _telemetryCtx
	if (!ctx) return
	resetFermentTrackingState(ctx.fermentTracking)
	ctx.fermentV2Context = undefined
}

/** @internal — exposed for testing only: the last-initialized instance's guard counters. */
export function _getBashGuardCounts(): { warn: number; block: number; allowedByUserRequest: number } {
	const counts = _telemetryCtx?.bashGuardCounts
	return counts ? { ...counts } : { warn: 0, block: 0, allowedByUserRequest: 0 }
}

// ---------------------------------------------------------------------------
// Token snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Capture the current cumulative token/cost counters for a phase.
 * Called at phase activation via the ferment:phase_started domain event.
 */
function captureSnapshot(ctx: TelemetryContext): TokenSnapshot {
	const { tokensByModel, costByModel } = ctx.cumulative
	const snapshot: TokenSnapshot = { inputByModel: {}, outputByModel: {}, costByModel: {} }
	for (const [model, t] of Object.entries(tokensByModel)) {
		snapshot.inputByModel[model] = t.input
		snapshot.outputByModel[model] = t.output
	}
	for (const [model, c] of Object.entries(costByModel)) {
		snapshot.costByModel[model] = c
	}
	return snapshot
}

function diffSnapshot(
	ctx: TelemetryContext,
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
	for (const [model, c] of Object.entries(costByModel)) {
		deltaCost += c - (snapshot.costByModel[model] ?? 0)
	}
	return {
		deltaInput: Math.max(0, deltaInput),
		deltaOutput: Math.max(0, deltaOutput),
		deltaCost: Math.max(0, deltaCost),
	}
}

function snapshotPhaseTokens(ctx: TelemetryContext, fermentId: string, phaseId: string): void {
	ctx.fermentTracking.phaseTokenSnapshots.set(`${fermentId}:${phaseId}`, captureSnapshot(ctx))
}

/**
 * Compute the token/cost delta since the snapshot taken at phase activation.
 * Removes the snapshot. Returns zeros when no snapshot exists.
 */
function consumePhaseTokenDelta(
	ctx: TelemetryContext,
	fermentId: string,
	phaseId: string,
): { deltaInput: number; deltaOutput: number; deltaCost: number } {
	const key = `${fermentId}:${phaseId}`
	const snapshot = ctx.fermentTracking.phaseTokenSnapshots.get(key)
	ctx.fermentTracking.phaseTokenSnapshots.delete(key)
	if (!snapshot) return { deltaInput: 0, deltaOutput: 0, deltaCost: 0 }
	return diffSnapshot(ctx, snapshot)
}

// ---------------------------------------------------------------------------
// Existing track* functions
// ---------------------------------------------------------------------------

export { trackFeedback, trackModelSwitchFeedback } from "./feedback.js"

export async function trackSubagentSpawned(
	args: { id: string; type: string; description: string },
	piCtx: ExtensionContext,
): Promise<void> {
	// Attribute to the SPAWNING session: the agents extension calling this runs
	// in the parent, and a subagent created in between (or a concurrent ACP
	// session) would otherwise steal the last-initialized global.
	const ctx = resolveSessionTelemetryCtx(piCtx.sessionManager.getSessionId())
	if (!isCtxEnabled(ctx)) return
	ctx.emit("subagent.spawned", { agent_type: args.type, reason: args.description }, piCtx)
}

export function trackSurveyShown(args: SurveyShownTelemetry, sessionId?: string): void {
	const ctx = resolveSessionTelemetryCtx(sessionId)
	if (!isCtxEnabled(ctx)) return
	emitSurveyShown(ctx, args)
}

export function trackSurveyAnswered(args: SurveyAnsweredTelemetry, sessionId?: string): void {
	const ctx = resolveSessionTelemetryCtx(sessionId)
	if (!isCtxEnabled(ctx)) return
	emitSurveyAnswered(ctx, args)
}

export function trackSurveyDismissed(args: SurveyDismissedTelemetry, sessionId?: string): void {
	const ctx = resolveSessionTelemetryCtx(sessionId)
	if (!isCtxEnabled(ctx)) return
	emitSurveyDismissed(ctx, args)
}

// ---------------------------------------------------------------------------
// Remote (cloud sandbox) execution tracking
// ---------------------------------------------------------------------------

/**
 * Lifecycle stages of a remote cloud-agent execution.
 */
export type RemoteExecutionStage =
	| "started"
	| "completed"
	| "failed"
	| "sync.started"
	| "sync.completed"
	| "sync.failed"
	| "push.started"
	| "push.completed"
	| "push.failed"
	| "steer.started"
	| "steer.completed"
	| "steer.failed"
	| "review.started"
	| "ide.opened"
	| "viewed"
	| "custom_action"
	| "done"

/** Execution stats for `completed`/`failed` lifecycle events. All numeric
 *  aggregates — no plan text, prompts, results, or file paths (privacy). */
export interface RemoteExecutionStats {
	duration_ms: number
	tool_calls: number
	turns?: number
	input_tokens: number
	output_tokens: number
}

/**
 * @param origin where the remote run originated, e.g. "plan", "plan-mode", "ferment plan"
 * @param stats numeric run stats — only meaningful for "completed"/"failed"
 * @param sessionId the session the run belongs to (session-keyed attribution);
 *  falls back to the last-initialized instance when omitted (pre-session calls)
 */
export function trackRemoteExecution(
	stage: RemoteExecutionStage,
	origin: string,
	stats?: RemoteExecutionStats,
	sessionId?: string,
): void {
	const ctx = resolveSessionTelemetryCtx(sessionId)
	if (!isCtxEnabled(ctx)) return
	ctx.emit(`remote_execution.${stage}`, { origin, ...stats })
}

// ---------------------------------------------------------------------------
// Ferment domain event handlers (subscribed via pi.events)
// ---------------------------------------------------------------------------

function onFermentStarted(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as FermentStartedPayload
	const tracking = ctx.fermentTracking
	tracking.fermentStartTimes.set(payload.fermentId, Date.now())
	// Capture a scoping snapshot at ferment start so we can compute token/cost
	// deltas for the scoping phase (before any phase is activated).
	tracking.scopingTokenSnapshots.set(payload.fermentId, captureSnapshot(ctx))
	// Initialise the running phase-delta accumulator. Totals are summed as
	// each phase completes rather than diffing the session accumulator at
	// ferment start/end (which over-counts scoping-conversation tokens).
	tracking.fermentTokenTotals.set(payload.fermentId, { input: 0, output: 0 })
	ctx.emitWithIds("ferment.started", {
		ferment_id: payload.fermentId,
		ferment_name: payload.name,
		phase_count: payload.phaseCount,
		model: ctx.currentModel,
	})
}

function externalFermentV2EventName(eventName: FermentV2EventName): string | undefined {
	switch (eventName) {
		case FERMENT_V2_EVENTS.STARTED:
			return "ferment_v2.started"
		case FERMENT_V2_EVENTS.REPLACED:
			return "ferment_v2.replaced"
		case FERMENT_V2_EVENTS.EDITED:
			return "ferment_v2.edited"
		case FERMENT_V2_EVENTS.RESUMED:
			return "ferment_v2.resumed"
		case FERMENT_V2_EVENTS.COMPLETED:
			return "ferment_v2.completed"
		case FERMENT_V2_EVENTS.BLOCKED:
			return "ferment_v2.blocked"
		case FERMENT_V2_EVENTS.PAUSED:
			return "ferment_v2.paused"
		case FERMENT_V2_EVENTS.CLEARED:
			return "ferment_v2.cleared"
		case FERMENT_V2_EVENTS.BUDGET_LIMITED:
			return "ferment_v2.budget_limited"
		case FERMENT_V2_EVENTS.STALLED:
			return "ferment_v2.stalled"
		case FERMENT_V2_EVENTS.AGENT_ERROR:
			return "ferment_v2.agent_error"
		case FERMENT_V2_EVENTS.EVALUATED:
		case FERMENT_V2_EVENTS.CONTEXT_CHANGED:
			return undefined
		default: {
			const _exhaustive: never = eventName
			return undefined
		}
	}
}

function fermentV2LifecycleTelemetryHandler(ctx: TelemetryContext, eventName: FermentV2EventName, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const externalName = externalFermentV2EventName(eventName)
	const payload = raw as Partial<FermentV2LifecyclePayload> | undefined
	if (!externalName || !payload?.fermentV2Id) return
	ctx.emitWithIds(externalName, {
		ferment_id: payload.fermentV2Id,
		ferment_v2_id: payload.fermentV2Id,
		ferment_version: "v2",
		ferment_revision: payload.revision ?? 0,
		status: payload.status ?? "",
		tokens_used: payload.tokensUsed ?? 0,
		duration_ms: payload.timeUsedMs ?? 0,
		token_budget: payload.tokenBudget ?? 0,
		completion_confidence: payload.completionConfidence ?? "",
		reason: payload.reason ?? "",
		replacement_ferment_id: payload.replacementFermentV2Id ?? "",
		continuation_count: payload.continuationCount ?? 0,
		consecutive_error_count: payload.consecutiveErrorCount ?? 0,
		model: ctx.currentModel,
	})
}

function fermentV2ContextChangedTelemetryHandler(ctx: TelemetryContext, raw: unknown): void {
	const payload = raw as Partial<FermentV2ContextChangedPayload> | undefined
	if (payload?.fermentV2Id) {
		const next: TelemetryFermentV2Context = {
			id: payload.fermentV2Id,
			revision: payload.revision ?? 0,
			status: payload.status ?? "active",
		}
		// Instance-scoped: only this session's emit enrichment sees it. The
		// old module global let one session's context bleed into every other
		// session's records on a concurrent multi-session host.
		ctx.fermentV2Context = next
		return
	}
	ctx.fermentV2Context = undefined
}

function fermentV2EvaluatedTelemetryHandler(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as Partial<FermentV2EvaluatedPayload> | undefined
	if (!payload?.fermentV2Id || !payload.verdict) return
	const usage = payload.usage
	ctx.emitWithIds("ferment_v2.evaluated", {
		...(payload.sessionId ? { pi_session_id: payload.sessionId } : {}),
		ferment_id: payload.fermentV2Id,
		ferment_v2_id: payload.fermentV2Id,
		ferment_version: "v2",
		ferment_revision: payload.revision ?? 0,
		status: payload.status ?? "",
		verdict: payload.verdict,
		evaluation_count: payload.count ?? 1,
		evaluator_model: payload.model ?? "unknown",
		duration_ms: payload.durationMs ?? 0,
		timeout_ms: payload.timeoutMs ?? 0,
		provider_request_count: payload.providerRequestCount ?? 0,
		timeout_count: payload.timeoutCount ?? 0,
		correction_count: payload.correctionCount ?? 0,
		failure_type: payload.failureType ?? "",
		http_status_code: payload.httpStatusCode ?? 0,
		total_input_tokens: usage?.input ?? 0,
		total_output_tokens: usage?.output ?? 0,
		cache_read_tokens: usage?.cacheRead ?? 0,
		cache_write_tokens: usage?.cacheWrite ?? 0,
		total_tokens: usage?.totalTokens ?? 0,
		total_cost_usd: usage?.costUsd ?? 0,
	})
}

function onFermentScopingResumed(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as FermentScopingResumedPayload
	const tracking = ctx.fermentTracking
	if (!tracking.fermentStartTimes.has(payload.fermentId))
		tracking.fermentStartTimes.set(payload.fermentId, payload.startedAtMs)
	if (!tracking.scopingTokenSnapshots.has(payload.fermentId)) {
		tracking.scopingTokenSnapshots.set(payload.fermentId, captureSnapshot(ctx))
	}
	if (!tracking.fermentTokenTotals.has(payload.fermentId)) {
		tracking.fermentTokenTotals.set(payload.fermentId, { input: 0, output: 0 })
	}
}

function onFermentCompleted(ctx: TelemetryContext, raw: unknown): void {
	const payload = raw as FermentCompletedPayload
	const tracking = ctx.fermentTracking
	// Read all tracking state BEFORE cleanup — cleanup deletes the
	// maps, so lookups after it return undefined.
	const startMs = tracking.fermentStartTimes.get(payload.fermentId) ?? 0
	const durationMs = startMs > 0 ? Date.now() - startMs : 0
	const steeringCount = tracking.fermentSteeringCounts.get(payload.fermentId) ?? 0
	const totals = tracking.fermentTokenTotals.get(payload.fermentId) ?? { input: 0, output: 0 }
	// Clean up all tracking state unconditionally — steering counts accumulate
	// regardless of whether telemetry is enabled, so cleanup must always run.
	cleanupFermentTrackingEntries(tracking, payload.fermentId)
	if (!isCtxEnabled(ctx)) return

	// Totals are the sum of per-phase deltas accumulated in onPhaseCompleted.
	// Using phase-delta sums (rather than a session-accumulator diff) avoids
	// counting scoping-conversation tokens that occur before phases start.
	const totalInput = totals.input
	const totalOutput = totals.output

	const attrs: TelemetryAttributes & { ferment_id: string } = {
		ferment_id: payload.fermentId,
		ferment_name: payload.name,
		phase_count: payload.phaseCount,
		duration_ms: durationMs,
		total_input_tokens: totalInput,
		total_output_tokens: totalOutput,
		steering_count: steeringCount,
		block_retries: payload.blockRetries,
	}
	if (payload.grade) attrs.grade = payload.grade
	ctx.emitWithIds("ferment.completed", attrs)
}

function onFermentAbandoned(ctx: TelemetryContext, raw: unknown): void {
	const payload = raw as FermentAbandonedPayload
	const tracking = ctx.fermentTracking
	// Read steering count BEFORE cleanup — cleanup deletes it.
	const steeringCount = tracking.fermentSteeringCounts.get(payload.fermentId) ?? 0
	// Clean up unconditionally — steering counts accumulate regardless of enabled state.
	cleanupFermentTrackingEntries(tracking, payload.fermentId)
	if (!isCtxEnabled(ctx)) return
	const attrs: TelemetryAttributes & { ferment_id: string } = {
		ferment_id: payload.fermentId,
		ferment_name: payload.name,
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
	ctx.emitWithIds("ferment.abandoned", attrs)
}

function onFermentStalled(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as FermentStalledPayload
	// No per-ferment Maps to clean up for stalled — ferment remains accessible.
	const attrs: TelemetryAttributes & { ferment_id: string } = {
		ferment_id: payload.fermentId,
		ferment_name: payload.name,
		lifecycle_stage: payload.lifecycleStage,
		idle_duration_ms: payload.idleDurationMs,
		completed_phases: payload.completedPhases,
		total_phases: payload.totalPhases,
		phase_completion_ratio: payload.phaseCompletionRatio,
	}
	ctx.emitWithIds("ferment.stalled", attrs)
}

function onPhaseStarted(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as FermentPhaseStartedPayload
	const tracking = ctx.fermentTracking
	const phaseKey = `${payload.fermentId}:${payload.phaseId}`
	tracking.phaseStartTimes.set(phaseKey, Date.now())
	tracking.phaseSteeringSnapshots.set(phaseKey, tracking.fermentSteeringCounts.get(payload.fermentId) ?? 0)
	snapshotPhaseTokens(ctx, payload.fermentId, payload.phaseId)
	ctx.emitWithIds("ferment.phase.started", {
		ferment_id: payload.fermentId,
		phase_id: payload.phaseId,
		phase_index: payload.phaseIndex,
		phase_name: payload.phaseName,
		model: ctx.currentModel,
	})
}

function onPhaseCompleted(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as FermentPhaseCompletedPayload
	const tracking = ctx.fermentTracking
	const phaseKey = `${payload.fermentId}:${payload.phaseId}`
	const phaseStartMs = tracking.phaseStartTimes.get(phaseKey) ?? 0
	tracking.phaseStartTimes.delete(phaseKey)
	const steeringAtStart = tracking.phaseSteeringSnapshots.get(phaseKey) ?? 0
	tracking.phaseSteeringSnapshots.delete(phaseKey)
	const steeringCount = (tracking.fermentSteeringCounts.get(payload.fermentId) ?? 0) - steeringAtStart
	const { deltaInput, deltaOutput } = consumePhaseTokenDelta(ctx, payload.fermentId, payload.phaseId)
	// Accumulate into the ferment-level running total.
	const ft = tracking.fermentTokenTotals.get(payload.fermentId)
	if (ft) {
		ft.input += deltaInput
		ft.output += deltaOutput
	}
	const attrs: TelemetryAttributes & { ferment_id: string } = {
		ferment_id: payload.fermentId,
		phase_id: payload.phaseId,
		phase_index: payload.phaseIndex,
		phase_name: payload.phaseName,
		duration_ms: phaseStartMs > 0 ? Date.now() - phaseStartMs : 0,
		delta_input_tokens: deltaInput,
		delta_output_tokens: deltaOutput,
		block_retries: payload.blockRetries,
		steering_count: steeringCount,
	}
	if (payload.grade) attrs.grade = payload.grade
	ctx.emitWithIds("ferment.phase.completed", attrs)
}

function onStepStarted(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as FermentStepStartedPayload
	const tracking = ctx.fermentTracking
	const key = `${payload.fermentId}:${payload.phaseId}:${payload.stepId}`
	tracking.stepStartTimes.set(key, Date.now())
	tracking.stepSteeringSnapshots.set(key, tracking.fermentSteeringCounts.get(payload.fermentId) ?? 0)
	ctx.emitWithIds("ferment.step.started", {
		ferment_id: payload.fermentId,
		phase_id: payload.phaseId,
		step_id: payload.stepId,
		step_index: payload.stepIndex,
		model: ctx.currentModel,
	})
}

function onStepCompleted(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as FermentStepCompletedPayload
	const tracking = ctx.fermentTracking
	const key = `${payload.fermentId}:${payload.phaseId}:${payload.stepId}`
	const startMs = tracking.stepStartTimes.get(key) ?? Date.now()
	tracking.stepStartTimes.delete(key)
	const steeringAtStart = tracking.stepSteeringSnapshots.get(key) ?? 0
	tracking.stepSteeringSnapshots.delete(key)
	const steeringCount = (tracking.fermentSteeringCounts.get(payload.fermentId) ?? 0) - steeringAtStart
	const attrs: TelemetryAttributes & { ferment_id: string } = {
		ferment_id: payload.fermentId,
		phase_id: payload.phaseId,
		step_id: payload.stepId,
		step_index: payload.stepIndex,
		duration_ms: Date.now() - startMs,
		success: payload.success,
		steering_count: steeringCount,
	}
	if (payload.grade) attrs.grade = payload.grade
	ctx.emitWithIds("ferment.step.completed", attrs)
}

function onStepFailed(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as FermentStepFailedPayload
	const tracking = ctx.fermentTracking
	const key = `${payload.fermentId}:${payload.phaseId}:${payload.stepId}`
	tracking.stepStartTimes.delete(key)
	const attrs: TelemetryAttributes & { ferment_id: string } = {
		ferment_id: payload.fermentId,
		phase_id: payload.phaseId,
		step_id: payload.stepId,
		step_index: payload.stepIndex,
	}
	if (payload.reason) attrs.reason = payload.reason.slice(0, 300)
	ctx.emitWithIds("ferment.step.failed", attrs)
}

function onFermentSteering(ctx: TelemetryContext, raw: unknown): void {
	// Accumulate regardless of telemetry enabled — count is emitted at
	// ferment.completed / ferment.abandoned which are gated on isCtxEnabled().
	const payload = raw as FermentSteeringPayload
	const tracking = ctx.fermentTracking
	const current = tracking.fermentSteeringCounts.get(payload.fermentId) ?? 0
	tracking.fermentSteeringCounts.set(payload.fermentId, current + 1)
}

function onScopingComplete(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as FermentScopingCompletedPayload
	const tracking = ctx.fermentTracking
	// In normal flows, STARTED initialized the baseline before scope fires.
	// If no baseline exists (unexpected path), we emit zeros for duration
	// and deltas rather than skipping the event entirely.
	const startMs = tracking.fermentStartTimes.get(payload.fermentId) ?? 0
	const durationMs = startMs > 0 ? Date.now() - startMs : 0
	const steeringCount = tracking.fermentSteeringCounts.get(payload.fermentId) ?? 0
	const snapshot = tracking.scopingTokenSnapshots.get(payload.fermentId)
	let deltaInput = 0
	let deltaOutput = 0
	let deltaCost = 0
	if (snapshot) {
		const diff = diffSnapshot(ctx, snapshot)
		deltaInput = diff.deltaInput
		deltaOutput = diff.deltaOutput
		deltaCost = diff.deltaCost
	}
	tracking.scopingTokenSnapshots.delete(payload.fermentId)
	const attrs: TelemetryAttributes & { ferment_id: string } = {
		ferment_id: payload.fermentId,
		session_id: ctx.resolveSessionId(),
		duration_ms: durationMs,
		steering_count: steeringCount,
		delta_input_tokens: deltaInput,
		delta_output_tokens: deltaOutput,
		delta_cost_usd: deltaCost,
		block_retries: Math.max(0, payload.proposeIterations - 1),
		model: ctx.currentModel,
	}
	ctx.emitWithIds("ferment.scoping.complete", attrs)
}

function onUserUnblocked(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as UserUnblockedPayload
	ctx.emitWithIds("user.unblock_time", {
		ferment_id: payload.fermentId,
		session_id: ctx.resolveSessionId(),
		duration_ms: payload.durationMs,
	})
}

// ---------------------------------------------------------------------------
// Bash-tool-guard domain event handlers
// ---------------------------------------------------------------------------

function onBashGuardWarn(ctx: TelemetryContext, raw: unknown): void {
	ctx.bashGuardCounts.warn++
	if (!isCtxEnabled(ctx)) return
	const payload = raw as BashToolGuardWarnPayload
	// Only structured fields land in OTLP. Raw command text is
	// intentionally NOT emitted to avoid leaking user data or secrets
	// that may appear inside heredocs, echo payloads, or sed/awk
	// replacement strings. Aggregation is done by category + tool.
	ctx.emit("bash_tool_guard.warn", {
		category: payload.category,
		tool: payload.tool,
		count: payload.count,
		interactive: payload.interactive,
	})
}

function onBashGuardBlock(ctx: TelemetryContext, raw: unknown): void {
	ctx.bashGuardCounts.block++
	if (!isCtxEnabled(ctx)) return
	const payload = raw as BashToolGuardBlockPayload
	ctx.emit("bash_tool_guard.block", {
		category: payload.category,
		tool: payload.tool,
		count: payload.count,
		interactive: payload.interactive,
	})
}

function onBashGuardAllowedByUserRequest(ctx: TelemetryContext, raw: unknown): void {
	ctx.bashGuardCounts.allowedByUserRequest++
	if (!isCtxEnabled(ctx)) return
	const payload = raw as BashToolGuardAllowedByUserRequestPayload
	ctx.emit("bash_tool_guard.allowed_by_user_request", {
		category: payload.category,
		tool: payload.tool,
	})
}

function onLoopGuardWarn(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as LoopGuardWarnPayload
	// Only structured fields land in OTLP. Raw tool args, command text, and
	// the human-readable reason string are intentionally NOT emitted to
	// avoid leaking user data. Mirrors the bash-tool-guard stance.
	ctx.emit("loop_guard.warn", {
		detector: payload.detector,
		count: payload.count,
		is_subagent: payload.is_subagent,
		interactive: payload.interactive,
	})
}

function onLoopGuardSubagentAbort(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	const payload = raw as LoopGuardSubagentAbortPayload
	ctx.emit("loop_guard.subagent_abort", {
		detector: payload.detector ?? "unknown",
		count: payload.count,
		is_subagent: payload.is_subagent,
	})
}

function onSubagentBashClamped(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	// Only the bound telemetry instance emits. agent-runner reloads the child
	// loader twice around bindExtensions (active-tools resolution), and each
	// reload re-invokes the inline extension factories against the loader's
	// SHARED event bus — the orphaned instance keeps its channel subscription
	// but is never bound to the session (it never receives session_start).
	// Without this guard every clamp would emit 2× subagent.bash_clamped.
	// Channel events can only fire after binding, so no legitimate emission is
	// suppressed (piSessionId is set by the session_start handler at bind).
	if (!ctx.piSessionId) return
	const payload = raw as Partial<SubagentBashClampedPayload> | undefined
	if (typeof payload?.toolCallId !== "string") return
	// Record the id first so the error reclassification in handlers/tools.ts
	// holds even when the rest of the payload is malformed — the clamp fact
	// stands on its own.
	ctx.clampedBashCalls.add(payload.toolCallId)
	ctx.emit("subagent.bash_clamped", {
		...(typeof payload.agentType === "string" && payload.agentType ? { agent_type: payload.agentType } : {}),
		reason: payload.reason === "budget_exhausted" ? "budget_exhausted" : "budget_tail",
		...(typeof payload.requestedTimeoutS === "number" ? { requested_timeout_s: payload.requestedTimeoutS } : {}),
		...(typeof payload.clampedToS === "number" ? { clamped_to_s: payload.clampedToS } : {}),
		...(typeof payload.remainingMs === "number" ? { remaining_ms: payload.remainingMs } : {}),
	})
}

// ---------------------------------------------------------------------------
// Steer/nudge domain event handlers (subscribed via pi.events)
// ---------------------------------------------------------------------------

function onSteerFired(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	handleSteerFired(ctx, raw)
}

function onSteerOutcome(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	handleSteerOutcome(ctx, raw)
}

function onSteerAborted(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	handleSteerAborted(ctx, raw)
}

// ---------------------------------------------------------------------------
// Permission domain event handlers (subscribed via pi.events)
// ---------------------------------------------------------------------------

function onToolDecision(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	handleToolDecision(ctx, raw as Partial<PermissionToolDecisionPayload>)
}

// ---------------------------------------------------------------------------
// Workflow domain event handler (subscribed via pi.events)
// ---------------------------------------------------------------------------

function onWorkflowTelemetry(ctx: TelemetryContext, raw: unknown): void {
	if (!isCtxEnabled(ctx)) return
	handleWorkflowEvent(ctx, raw)
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function telemetryExtension(config: TelemetryConfig) {
	return (pi: ExtensionAPI) => {
		if (!config.enabled) return

		const telemetryCtx = new TelemetryContext(config)
		_telemetryCtx = telemetryCtx

		// Per-session conversation id. Each extension instance belongs to one
		// AgentSession, so this closure variable is naturally scoped to that
		// session — including subagents, which get their own extension instance.
		let conversationId = randomUUID()

		// Whether this instance has emitted its session.start record. Instance-
		// scoped: the module-global it replaces suppressed the session.start
		// record of every session after the first in a multi-session process.
		let sessionStartEmitted = false

		// Watch the settings file for changes and emit telemetry on modification.
		// Bound to ctx.emit so changes flow through the same OTLP pipeline. The
		// returned stop fn is invoked on session_shutdown to close the fs.watch
		// handle and clear the debounce timer (prevents handle leak / hang).
		const stopSettingsWatcher = startSettingsChangeWatcher((event, properties) => telemetryCtx.emit(event, properties))

		// Subscribe to ferment domain events published via pi.events.
		// This keeps telemetry decoupled from ferment internals — ferment
		// publishes facts; telemetry translates them into OTLP records.
		// Every subscription closes over THIS instance's telemetryCtx: the
		// handlers used to read a module-global pointer, so a concurrent
		// session's (or a subagent's) context could steal the records of
		// events emitted on this session's bus.
		pi.events.on(FERMENT_EVENTS.STARTED, (raw) => onFermentStarted(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.COMPLETED, (raw) => onFermentCompleted(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.ABANDONED, (raw) => onFermentAbandoned(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.STALLED, (raw) => onFermentStalled(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.PHASE_STARTED, (raw) => onPhaseStarted(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.PHASE_COMPLETED, (raw) => onPhaseCompleted(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.STEP_STARTED, (raw) => onStepStarted(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.STEP_COMPLETED, (raw) => onStepCompleted(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.STEP_FAILED, (raw) => onStepFailed(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.STEERING, (raw) => onFermentSteering(telemetryCtx, raw))
		pi.events.on(FERMENT_V2_EVENTS.STARTED, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.STARTED, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.REPLACED, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.REPLACED, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.EDITED, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.EDITED, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.RESUMED, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.RESUMED, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.COMPLETED, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.COMPLETED, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.BLOCKED, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.BLOCKED, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.PAUSED, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.PAUSED, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.CLEARED, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.CLEARED, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.BUDGET_LIMITED, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.BUDGET_LIMITED, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.STALLED, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.STALLED, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.AGENT_ERROR, (raw) =>
			fermentV2LifecycleTelemetryHandler(telemetryCtx, FERMENT_V2_EVENTS.AGENT_ERROR, raw),
		)
		pi.events.on(FERMENT_V2_EVENTS.CONTEXT_CHANGED, (raw) => fermentV2ContextChangedTelemetryHandler(telemetryCtx, raw))
		pi.events.on(FERMENT_V2_EVENTS.EVALUATED, (raw) => fermentV2EvaluatedTelemetryHandler(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.SCOPING_RESUMED, (raw) => onFermentScopingResumed(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.SCOPING_COMPLETE, (raw) => onScopingComplete(telemetryCtx, raw))
		pi.events.on(FERMENT_EVENTS.USER_UNBLOCKED, (raw) => onUserUnblocked(telemetryCtx, raw))

		// Subscribe to bash-tool-guard domain events. The guard publishes
		// facts; telemetry translates them into OTLP records for analytics.
		pi.events.on(BASH_TOOL_GUARD_EVENTS.WARN, (raw) => onBashGuardWarn(telemetryCtx, raw))
		pi.events.on(BASH_TOOL_GUARD_EVENTS.BLOCK, (raw) => onBashGuardBlock(telemetryCtx, raw))
		pi.events.on(BASH_TOOL_GUARD_EVENTS.ALLOWED_BY_USER_REQUEST, (raw) =>
			onBashGuardAllowedByUserRequest(telemetryCtx, raw),
		)

		// Subscribe to loop-guard domain events. The guard publishes facts;
		// telemetry translates them into OTLP records for analytics.
		pi.events.on(LOOP_GUARD_EVENTS.WARN, (raw) => onLoopGuardWarn(telemetryCtx, raw))
		pi.events.on(LOOP_GUARD_EVENTS.SUBAGENT_ABORT, (raw) => onLoopGuardSubagentAbort(telemetryCtx, raw))

		// Subscribe to the subagent bash-clamp channel. The clamp publishes a
		// fact whenever it reduces a bash timeout below the resolved value;
		// telemetry translates it into the `subagent.bash_clamped` lifecycle
		// event and records the call id so handlers/tools.ts reclassifies the
		// resulting tool error instead of emitting a generic tool_failure
		// (expected containment, not an anomaly).
		pi.events.on(SUBAGENT_BASH_CLAMP_EVENTS.CLAMPED, (raw) => onSubagentBashClamped(telemetryCtx, raw))

		// Subscribe to steer/nudge domain events. Guard/nudge
		// extensions publish fire/outcome facts; telemetry forwards them
		// through the attribute allowlist in handlers/steers.ts. Subscribed
		// with closures over the per-session telemetryCtx — the steer handlers
		// mutate session state (steerFiredCount, lastSteer), so routing them
		// through the module-global pointer would cross sessions on a
		// concurrent multi-session ACP host.
		pi.events.on(STEER_EVENTS.FIRED, (raw) => onSteerFired(telemetryCtx, raw))
		pi.events.on(STEER_EVENTS.OUTCOME, (raw) => onSteerOutcome(telemetryCtx, raw))
		pi.events.on(STEER_EVENTS.ABORTED, (raw) => onSteerAborted(telemetryCtx, raw))

		// Subscribe to permission decision events. The permissions extension
		// publishes one fact per gated tool decision; telemetry translates them
		// into `claude_code.tool_decision` OTLP records (the acceptance signal).
		pi.events.on(PERMISSION_EVENTS.TOOL_DECISION, (raw) => onToolDecision(telemetryCtx, raw))

		// Workflow domain events (kimchi-workflows): one envelope channel covers the whole contract.
		pi.events.on(WORKFLOW_TELEMETRY_CHANNEL, (raw) => onWorkflowTelemetry(telemetryCtx, raw))

		pi.on("session_start", async (_event, ctx) => {
			conversationId = randomUUID()
			handleSessionStart(telemetryCtx, ctx)
			registerSessionContext(telemetryCtx.piSessionId, telemetryCtx)
		})
		pi.on("session_shutdown", async (event, ctx) => {
			stopSettingsWatcher()
			unregisterSessionContext(telemetryCtx.piSessionId)
			await handleSessionShutdown(telemetryCtx, ctx, event)
		})
		pi.on("message_start", async (event, ctx) => {
			handleMessageStart(telemetryCtx, ctx, event as { message: Message })
		})
		pi.on("message_end", async (event, ctx) => {
			handleMessageEnd(telemetryCtx, ctx, event as { message: Message })
		})
		pi.on("model_select", async (event) => {
			telemetryCtx.currentModel = event.model.id
		})
		pi.on("session_compact", async (_event, ctx) => {
			handleSessionCompact(telemetryCtx, ctx)
		})
		pi.on("tool_execution_start", async (event) => {
			// Pi emits this before rejecting unknown tools; the name can contain generated content.
			// In-flight tools can outlive their active visibility, so check registered definitions.
			const toolName = pi.getAllTools().some((tool) => tool.name === event.toolName) ? event.toolName : "unknown"
			handleToolExecutionStart(telemetryCtx, { ...event, toolName })
		})
		pi.on("tool_execution_end", async (event, ctx) => {
			handleToolExecutionEnd(telemetryCtx, ctx, event)
		})
		pi.on("before_agent_start", async (event, ctx) => {
			// upstream pi: the event fires for extension-triggered runs too and is a
			// union — only user prompts carry `prompt`.
			if (event.messageType !== "user") return
			if (!sessionStartEmitted) {
				sessionStartEmitted = true
				emitSessionStartEvent(telemetryCtx, ctx)
			}
			handleBeforeAgentStart(telemetryCtx, ctx, event)
		})
		pi.on("agent_end", async (event, ctx) => {
			handleAgentEnd(telemetryCtx, ctx, event)
		})
		pi.on("turn_start", async () => {
			// One LLM turn (round-trip) per turn_start, counted session-wide:
			// upstream's event.turnIndex resets per agent run, so it is ignored
			// in favor of kimchi's own 1-based strictly-increasing counter.
			telemetryCtx.advanceTurn()
		})
		pi.on("before_provider_headers", (event) => {
			event.headers[TELEMETRY_PROVIDER_HEADER_NAMES.sessionId] = telemetryCtx.resolveSessionId()
			event.headers[TELEMETRY_PROVIDER_HEADER_NAMES.conversationId] = conversationId
			// 1-based session turn counter; 0 only on requests issued before the
			// session's first LLM turn (e.g. warmup calls) — treat as pre-turn.
			event.headers[TELEMETRY_PROVIDER_HEADER_NAMES.turnIndex] = String(telemetryCtx.turnIndex)

			// Requests issued from inside a subagent run carry the parent session's
			// pi session id so the proxy can record it on chat_completions rows
			// (same gating/value as the session.parent_id telemetry attribute).
			const parentSessionId = telemetryCtx.getParentSessionId()
			if (parentSessionId) {
				event.headers[TELEMETRY_PROVIDER_HEADER_NAMES.parentSessionId] = parentSessionId
			}

			// Inject W3C Trace Context (if not already present) with a fresh
			// per-request trace id so each LLM request forms its own small,
			// bounded downstream trace instead of every request of a multi-hour
			// session piling into one giant trace.
			// Session grouping stays in the X-Session-Id header above. Header names are case-insensitive, so check all
			// keys rather than a single property name.
			const hasTraceparent = Object.keys(event.headers).some(
				(name) => name.toLowerCase() === TELEMETRY_PROVIDER_HEADER_NAMES.traceparent,
			)
			if (!hasTraceparent) {
				const traceId = randomBytes(16).toString("hex")
				const spanId = randomBytes(8).toString("hex")
				event.headers[TELEMETRY_PROVIDER_HEADER_NAMES.traceparent] = `00-${traceId}-${spanId}-01`
				telemetryCtx.lastTraceContext = { traceId, spanId }
			} else {
				// An upstream component supplied the context — record it so
				// telemetry events still join to whichever trace the request
				// actually went out under. Malformed ids leave the context
				// undefined rather than stamping a stale request's trace.
				const existing = Object.entries(event.headers).find(
					([name]) => name.toLowerCase() === TELEMETRY_PROVIDER_HEADER_NAMES.traceparent,
				)?.[1]
				const parts = existing?.split("-")
				const traceId = parts?.length === 4 ? parts[1].toLowerCase() : undefined
				const spanId = parts?.length === 4 ? parts[2].toLowerCase() : undefined
				telemetryCtx.lastTraceContext =
					traceId && /^[0-9a-f]{32}$/.test(traceId) && spanId && /^[0-9a-f]{16}$/.test(spanId)
						? { traceId, spanId }
						: undefined
			}
		})
	}
}
