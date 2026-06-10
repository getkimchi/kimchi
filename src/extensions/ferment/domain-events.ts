/**
 * Ferment domain event channels published via pi.events.
 *
 * The ferment extension emits these events; the telemetry extension
 * subscribes to them. This keeps ferment isolated from telemetry and
 * ensures every state transition is observed regardless of which code
 * path triggered it.
 */

export const FERMENT_EVENTS = {
	STARTED: "ferment:started",
	COMPLETED: "ferment:completed",
	ABANDONED: "ferment:abandoned",
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
