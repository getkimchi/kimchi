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
	type FermentStartedPayload,
	type FermentStepCompletedPayload,
	type FermentStepFailedPayload,
	type FermentStepStartedPayload,
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
			const payload: FermentAbandonedPayload = {
				fermentId: post.id,
				name: post.name,
				reason: cmd.reason,
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
				// Duration and delta tokens are computed by the telemetry subscriber
				// using its own snapshots taken at phase activation.
				durationMs: 0,
				deltaInputTokens: 0,
				deltaOutputTokens: 0,
				blockRetries: cmd.type === "complete_phase" ? (cmd.blockRetries ?? 0) : 0,
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
				// Duration computed by telemetry subscriber using its own start time snapshot.
				durationMs: 0,
				grade: step.grade?.grade,
				success: step.status === "done" || step.status === "verified",
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
			}
			events.emit(FERMENT_EVENTS.STEP_COMPLETED, payload)
			return
		}

		default:
			// Other commands (pause, resume, refine, scope, etc.) don't need
			// telemetry events — they don't represent lifecycle transitions.
			return
	}
}
