/**
 * Emits ferment domain events via pi.events based on command type and
 * the resulting ferment state after applyAndPersist succeeds.
 *
 * This is the single place that translates state-machine commands into
 * observable domain events. The telemetry extension subscribes to these
 * events — ferment code never imports from telemetry.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent"
import type { Command } from "../../ferment/state-machine.js"
import type { Ferment } from "../../ferment/types.js"
import {
	FERMENT_EVENTS,
	type FermentAbandonedPayload,
	type FermentCompletedPayload,
	type FermentPhaseCompletedPayload,
	type FermentPhaseStartedPayload,
	type FermentResumedPayload,
	type FermentStartedPayload,
	type FermentStepCompletedPayload,
	type FermentStepFailedPayload,
	type FermentStepStartedPayload,
	type FermentSuspendedPayload,
} from "./domain-events.js"

/** Warn in non-production environments when a state-lookup fails, indicating
 *  a mismatch between the emitted command and the resulting Ferment state. */
function warnMismatch(cmdType: string, detail: string): void {
	if (process.env.NODE_ENV !== "production") {
		console.warn(`[ferment-events] ${cmdType}: ${detail} — event not emitted`)
	}
}

export function emitFermentCreated(events: EventBus, ferment: Ferment): void {
	const payload: FermentStartedPayload = {
		fermentId: ferment.id,
		name: ferment.name,
		phaseCount: ferment.phases.length,
	}
	events.emit(FERMENT_EVENTS.STARTED, payload)
}

export function emitFermentDomainEvent(events: EventBus, cmd: Command, post: Ferment): void {
	switch (cmd.type) {
		case "complete_ferment": {
			const payload: FermentCompletedPayload = {
				fermentId: post.id,
				name: post.name,
				grade: post.grade?.grade,
				phaseCount: post.phases.length,
				// Duration and token fields are computed by the telemetry subscriber
				// using its own snapshots — they are not available here.
				durationMs: 0,
				totalInputTokens: 0,
				totalOutputTokens: 0,
				steeringCount: 0,
				blockRetries: post.phases.filter((p) => p.status === "failed").length,
			}
			events.emit(FERMENT_EVENTS.COMPLETED, payload)
			return
		}

		case "abandon": {
			const completedPhases = post.phases.filter((p) => p.status === "completed").length
			const totalPhases = post.phases.length
			const lastActivePhase = post.phases.find((p) => p.id === post.activePhaseId)
			const stepFailureCount = post.phases.reduce((n, p) => n + p.steps.filter((s) => s.status === "failed").length, 0)
			const createdMs = post.createdAt ? Date.parse(post.createdAt) : Number.NaN
			const durationMs = Number.isFinite(createdMs) ? Date.now() - createdMs : 0
			const payload: FermentAbandonedPayload = {
				fermentId: post.id,
				name: post.name,
				reason: cmd.reason,
				lifecycleStage: post.status,
				scopingComplete: !!(post.scoping?.goal?.confirmedAt && post.scoping?.criteria?.confirmedAt),
				completedPhases,
				totalPhases,
				phaseCompletionRatio: totalPhases > 0 ? completedPhases / totalPhases : 0,
				lastActivePhaseIndex: lastActivePhase?.index,
				stepFailureCount,
				durationMs,
			}
			events.emit(FERMENT_EVENTS.ABANDONED, payload)
			return
		}

		case "activate_phase": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			if (!phase) {
				warnMismatch(cmd.type, `phase ${cmd.phaseId} not found`)
				return
			} // guarded below
			if (!phase) {
				if (process.env.NODE_ENV !== "production")
					console.warn(`[ferment-events] ${cmd.type}: phase ${cmd.phaseId} not found in post-state`)
				return
			}
			const payload: FermentPhaseStartedPayload = {
				fermentId: post.id,
				phaseId: phase.id,
				phaseIndex: phase.index,
				phaseName: phase.name,
			}
			events.emit(FERMENT_EVENTS.PHASE_STARTED, payload)
			return
		}

		case "activate_phase_group": {
			// Each phase in the group gets its own phase_started event.
			for (const phase of post.phases) {
				if (phase.groupIndex !== cmd.groupIndex || phase.status !== "active") continue
				const payload: FermentPhaseStartedPayload = {
					fermentId: post.id,
					phaseId: phase.id,
					phaseIndex: phase.index,
					phaseName: phase.name,
				}
				events.emit(FERMENT_EVENTS.PHASE_STARTED, payload)
			}
			return
		}

		case "complete_phase":
		case "skip_phase":
		case "fail_phase": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			if (!phase) {
				warnMismatch(cmd.type, `phase ${cmd.phaseId} not found`)
				return
			} // guarded below
			if (!phase) {
				if (process.env.NODE_ENV !== "production")
					console.warn(`[ferment-events] ${cmd.type}: phase ${cmd.phaseId} not found in post-state`)
				return
			}
			const payload: FermentPhaseCompletedPayload = {
				fermentId: post.id,
				phaseId: phase.id,
				phaseIndex: phase.index,
				phaseName: phase.name,
				grade: cmd.type === "complete_phase" ? cmd.grade?.grade : undefined,
				// Duration, delta tokens, and steering count are computed by the
				// telemetry subscriber using its own snapshots taken at phase activation.
				durationMs: 0,
				deltaInputTokens: 0,
				deltaOutputTokens: 0,
				blockRetries: cmd.type === "complete_phase" ? (cmd.blockRetries ?? 0) : 0,
				steeringCount: 0,
			}
			events.emit(FERMENT_EVENTS.PHASE_COMPLETED, payload)
			return
		}

		case "start_step": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			const step = phase?.steps.find((s) => s.id === cmd.stepId)
			if (!phase || !step) {
				warnMismatch(cmd.type, `phase ${cmd.phaseId} or step ${cmd.stepId} not found`)
				return
			}
			const payload: FermentStepStartedPayload = {
				fermentId: post.id,
				phaseId: phase.id,
				stepId: step.id,
				stepIndex: step.index,
			}
			events.emit(FERMENT_EVENTS.STEP_STARTED, payload)
			return
		}

		case "complete_step":
		case "verify_step": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			const step = phase?.steps.find((s) => s.id === cmd.stepId)
			if (!phase || !step) {
				warnMismatch(cmd.type, `phase ${cmd.phaseId} or step ${cmd.stepId} not found`)
				return
			}
			const payload: FermentStepCompletedPayload = {
				fermentId: post.id,
				phaseId: phase.id,
				stepId: step.id,
				stepIndex: step.index,
				// Duration and steering count are computed by the telemetry subscriber
				// using its own snapshots taken at step start.
				durationMs: 0,
				grade: step.grade?.grade,
				success: step.status === "done" || step.status === "verified",
				steeringCount: 0,
			}
			events.emit(FERMENT_EVENTS.STEP_COMPLETED, payload)
			return
		}

		case "fail_step": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			const step = phase?.steps.find((s) => s.id === cmd.stepId)
			if (!phase || !step) {
				warnMismatch(cmd.type, `phase ${cmd.phaseId} or step ${cmd.stepId} not found`)
				return
			}
			const payload: FermentStepFailedPayload = {
				fermentId: post.id,
				phaseId: phase.id,
				stepId: step.id,
				stepIndex: step.index,
				reason: cmd.error,
			}
			events.emit(FERMENT_EVENTS.STEP_FAILED, payload)
			return
		}

		case "skip_step": {
			const phase = post.phases.find((p) => p.id === cmd.phaseId)
			const step = phase?.steps.find((s) => s.id === cmd.stepId)
			if (!phase || !step) {
				warnMismatch(cmd.type, `phase ${cmd.phaseId} or step ${cmd.stepId} not found`)
				return
			}
			const payload: FermentStepCompletedPayload = {
				fermentId: post.id,
				phaseId: phase.id,
				stepId: step.id,
				stepIndex: step.index,
				durationMs: 0,
				success: true,
				steeringCount: 0,
			}
			events.emit(FERMENT_EVENTS.STEP_COMPLETED, payload)
			return
		}

		case "pause": {
			const payload: FermentSuspendedPayload = {
				fermentId: post.id,
			}
			events.emit(FERMENT_EVENTS.SUSPENDED, payload)
			return
		}

		case "resume": {
			const payload: FermentResumedPayload = {
				fermentId: post.id,
			}
			events.emit(FERMENT_EVENTS.RESUMED, payload)
			return
		}

		default:
			// Other commands (refine, scope, etc.) don't need domain events —
			// they don't represent lifecycle transitions.
			return
	}
}
