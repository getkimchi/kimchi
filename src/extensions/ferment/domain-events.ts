/**
 * Ferment domain event channels published via pi.events.
 *
 * The ferment extension emits these events; the telemetry extension
 * subscribes to them. This keeps ferment isolated from telemetry and
 * ensures every state transition is observed regardless of which code
 * path triggered it.
 */

import type { FermentStatus } from "../../ferment/types.js"

export const FERMENT_EVENTS = {
	STARTED: "ferment:started",
	COMPLETED: "ferment:completed",
	ABANDONED: "ferment:abandoned",
	SUSPENDED: "ferment:suspended",
	RESUMED: "ferment:resumed",
	STALLED: "ferment:stalled",
	PHASE_STARTED: "ferment:phase_started",
	PHASE_COMPLETED: "ferment:phase_completed",
	STEP_STARTED: "ferment:step_started",
	STEP_COMPLETED: "ferment:step_completed",
	STEP_FAILED: "ferment:step_failed",
	STEERING: "ferment:steering",
} as const

export type FermentEventChannel = (typeof FERMENT_EVENTS)[keyof typeof FERMENT_EVENTS]

// ---------------------------------------------------------------------------
// Payload types — matched by the telemetry subscriber
// ---------------------------------------------------------------------------

export interface FermentStartedPayload {
	fermentId: string
	name: string
	phaseCount: number
}

export interface FermentCompletedPayload {
	fermentId: string
	name: string
	grade?: string
	phaseCount: number
	/** Wall-clock duration in ms from ferment creation to completion. 0 when start time unavailable. */
	durationMs: number
	totalInputTokens: number
	totalOutputTokens: number
	steeringCount: number
	/** Total failed phases (proxy for ferment-level block retries). */
	blockRetries: number
}

export interface FermentAbandonedPayload {
	fermentId: string
	name: string
	reason?: string
	/** Lifecycle stage the ferment was in when abandoned. */
	lifecycleStage: FermentStatus
	/** Whether scoping (goal + criteria) was confirmed before abandonment. */
	scopingComplete: boolean
	/** Number of phases that reached "completed" status. */
	completedPhases: number
	/** Total number of phases in the ferment plan. */
	totalPhases: number
	/** Ratio of completed phases to total phases (0–1). 0 when totalPhases is 0. */
	phaseCompletionRatio: number
	/** 1-based index of the last active phase, or undefined if no phase was ever activated. */
	lastActivePhaseIndex?: number
	/** Total number of steps that reached "failed" status across all phases. */
	stepFailureCount: number
	/** Wall-clock duration in ms from ferment creation to abandonment. */
	durationMs: number
}

export interface FermentSuspendedPayload {
	fermentId: string
}

export interface FermentResumedPayload {
	fermentId: string
}

export interface FermentPhaseStartedPayload {
	fermentId: string
	phaseId: string
	phaseIndex: number
	phaseName: string
}

export interface FermentPhaseCompletedPayload {
	fermentId: string
	phaseId: string
	phaseIndex: number
	phaseName: string
	grade?: string
	durationMs: number
	deltaInputTokens: number
	deltaOutputTokens: number
	blockRetries: number
	steeringCount: number
}

export interface FermentStepStartedPayload {
	fermentId: string
	phaseId: string
	stepId: string
	stepIndex: number
}

export interface FermentStepCompletedPayload {
	fermentId: string
	phaseId: string
	stepId: string
	stepIndex: number
	durationMs: number
	grade?: string
	success: boolean
	steeringCount: number
}

export interface FermentStepFailedPayload {
	fermentId: string
	phaseId: string
	stepId: string
	stepIndex: number
	reason?: string
}

export interface FermentSteeringPayload {
	fermentId: string
}

export interface FermentStalledPayload {
	fermentId: string
	name: string
	/** Lifecycle stage of the ferment when stalling was detected. */
	lifecycleStage: FermentStatus
	/** How long the ferment has been idle in ms (since lastActiveAt). 0 when unavailable. */
	idleDurationMs: number
	/** Number of phases that reached "completed" status. */
	completedPhases: number
	/** Total number of phases in the ferment plan. */
	totalPhases: number
	/** Ratio of completed phases to total phases (0–1). 0 when totalPhases is 0. */
	phaseCompletionRatio: number
}
