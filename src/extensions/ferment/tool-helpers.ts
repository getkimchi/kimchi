/**
 * Tool result builders + entity resolvers shared across tool implementations.
 *
 * Also exposes `applyAndPersist` — the bridge between tool handlers and the
 * pure state machine. Tool handlers should construct a `Command`, call this
 * helper, and either return its error or use the resulting ferment to format
 * a success response.
 */

import { determineNextAction } from "../../ferment/engine.js"
import { commandToEvents } from "../../ferment/event-mapper.js"
import type { Command, TransitionError } from "../../ferment/state-machine.js"
import { applyCommand } from "../../ferment/state-machine.js"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { publicToolNameForActionKind } from "./action-tool-names.js"
import { emitFermentDomainEvent } from "./domain-events-emitter.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"

// ─── Tool result builders ─────────────────────────────────────────────────────
// Every tool execute returns the same { details, content, isError? } shape;
// these helpers cut the visual noise.

export function toolOk(text: string) {
	return { details: undefined, content: [{ type: "text" as const, text }] }
}

export function toolErr(text: string) {
	return { details: undefined, content: [{ type: "text" as const, text }], isError: true }
}

export function formatNextActionHint(ferment: Ferment): string | undefined {
	const action = determineNextAction(ferment)
	if (!action) return undefined
	const toolName = publicToolNameForActionKind(action.kind)

	// Look up phase/step context so the hint names the actual work, not just IDs.
	const actionPhase = "phaseId" in action ? ferment.phases.find((p) => p.id === action.phaseId) : undefined
	const phaseName = actionPhase ? `"${actionPhase.name}"` : undefined
	const phaseLabel = actionPhase ? `phase ${actionPhase.index}/${ferment.phases.length} ${phaseName}` : undefined

	const actionStep =
		"stepId" in action && actionPhase ? actionPhase.steps.find((s) => s.id === action.stepId) : undefined
	const stepLabel = actionStep
		? `step ${actionStep.index}/${actionPhase?.steps.length} \u2014 "${actionStep.description}"`
		: undefined
	const verifyHint = actionStep?.verification?.command ? ` (verify: \`${actionStep.verification.command}\`)` : ""

	switch (action.kind) {
		case "scope":
			return `Next action: call \`${toolName}\` with ferment_id "${ferment.id}" \u2014 include goal, success_criteria, constraints, phases (each step needs a description), and the full P1/P2/P3 gates array.`
		case "activate_phase": {
			const label = phaseLabel ?? `phase "${action.phaseId}"`
			return `Next action: call \`${toolName}\` now \u2014 ferment_id "${ferment.id}", phase_id "${action.phaseId}" (${label}).`
		}
		case "refine": {
			const label = phaseLabel ?? `phase "${action.phaseId}"`
			return `Next action: call \`${toolName}\` to add concrete steps to ${label} \u2014 ferment_id "${ferment.id}", phase_id "${action.phaseId}".`
		}
		case "start_step": {
			const label = stepLabel ?? `step "${action.stepId}"`
			return `Next action: call \`${toolName}\` to begin ${label}, then immediately spawn an Agent worker for the implementation \u2014 ferment_id "${ferment.id}", phase_id "${action.phaseId}", step_id "${action.stepId}"${verifyHint}.`
		}
		case "complete_step": {
			const label = stepLabel ?? `step "${action.stepId}"`
			return `Next action: call \`${toolName}\` once the worker for ${label} has returned \u2014 ferment_id "${ferment.id}", phase_id "${action.phaseId}", step_id "${action.stepId}"${verifyHint}.`
		}
		case "verify_step": {
			const label = stepLabel ?? `step "${action.stepId}"`
			return `Next action: call \`${toolName}\` to verify ${label} \u2014 ferment_id "${ferment.id}", phase_id "${action.phaseId}", step_id "${action.stepId}"${verifyHint}.`
		}
		case "complete_phase": {
			const label = phaseLabel ?? `phase "${action.phaseId}"`
			const doneCount = actionPhase?.steps.filter(
				(s) => s.status === "done" || s.status === "verified" || s.status === "skipped",
			).length
			const totalCount = actionPhase?.steps.length
			const progress =
				doneCount !== undefined && totalCount !== undefined ? ` (${doneCount}/${totalCount} steps done)` : ""
			return `Next action: call \`${toolName}\` now \u2014 all steps in ${label} are terminal${progress} \u2014 ferment_id "${ferment.id}", phase_id "${action.phaseId}".`
		}
		case "complete_ferment":
			return `Next action: call \`${toolName}\` now \u2014 all phases are terminal \u2014 ferment_id "${ferment.id}".`
		case "recover_step": {
			const label = stepLabel ?? `step "${action.stepId}"`
			return `Next action: ${label} failed \u2014 diagnose the failure, then call \`start_ferment_step\`, \`skip_ferment_step\`, or \`fail_ferment_step\` with ferment_id "${ferment.id}", phase_id "${action.phaseId}", step_id "${action.stepId}".`
		}
		case "recover_phase": {
			const label = phaseLabel ?? `phase "${action.phaseId}"`
			return `Next action: ${label} failed \u2014 diagnose the failure, then call \`activate_ferment_phase\` to retry, \`skip_ferment_phase\` to bypass, or ask the user whether to abandon \u2014 ferment_id "${ferment.id}", phase_id "${action.phaseId}".`
		}
		case "pause":
			return "Next action: wait for the user to run /ferment resume \u2014 do not call ferment lifecycle tools while paused."
	}
}

export function withNextActionHint(text: string, ferment: Ferment | undefined): string {
	const hint = ferment ? formatNextActionHint(ferment) : undefined
	return hint ? `${text}\n\n${hint}` : text
}

export function toolErrWithNextAction(text: string, ferment: Ferment | undefined) {
	return toolErr(withNextActionHint(text, ferment))
}

// ─── Resolvers ────────────────────────────────────────────────────────────────

/** Resolve a phase by exact id → name substring → active phase. */
export function resolvePhase(f: Ferment, phaseId: string): Phase | undefined {
	let phase = f.phases.find((p) => p.id === phaseId)
	if (!phase) {
		const needle = phaseId.toLowerCase()
		phase = f.phases.find((p) => p.name.toLowerCase().includes(needle))
	}
	if (!phase) {
		phase = f.phases.find((p) => p.status === "active")
	}
	return phase
}

/** Resolve a step by exact id → step-N index format. */
export function resolveStep(phase: Phase, stepId: string): Step | undefined {
	let step = phase.steps.find((s) => s.id === stepId)
	if (!step) {
		const idxMatch = stepId.match(/(\d+)$/)
		if (idxMatch) {
			const idx = Number.parseInt(idxMatch[1], 10)
			step = phase.steps.find((s) => s.index === idx)
		}
	}
	return step
}

// ─── State machine bridge ─────────────────────────────────────────────────────

/**
 * Apply a state-machine command, persist the result, and update the active
 * ferment cache. Returns either the new ferment or a transition error.
 *
 * This is the canonical path for tool handlers: load → apply → persist.
 * Anything else (judge calls, side effects, formatting) is the host's job.
 */
export type ApplyOutcome =
	| { ok: true; ferment: Ferment }
	| {
			ok: false
			error:
				| TransitionError
				| { code: "FERMENT_NOT_FOUND"; message: string }
				| { code: "FERMENT_PAUSED"; message: string }
	  }

// Commands the user/host can issue even when the ferment is paused. Everything
// else is structurally rejected at the bridge — no tool calls can mutate state
// while paused. This is the load-bearing piece of the pause feature.
const COMMANDS_ALLOWED_WHILE_PAUSED = new Set<Command["type"]>(["resume", "abandon"])

export function createApplyAndPersist(runtime: FermentRuntime) {
	return (fermentId: string, cmd: Command): ApplyOutcome => {
		const storage = runtime.getStorage()
		const outcome = storage.mutateWithEvents(
			fermentId,
			(
				current,
			):
				| { write: true; ferment: Ferment; events: ReturnType<typeof commandToEvents>; value: ApplyOutcome }
				| { write: false; value: ApplyOutcome } => {
				if (!current) {
					return {
						write: false,
						value: { ok: false, error: { code: "FERMENT_NOT_FOUND", message: `Ferment not found: ${fermentId}` } },
					}
				}
				if (current.status === "paused" && !COMMANDS_ALLOWED_WHILE_PAUSED.has(cmd.type)) {
					return {
						write: false,
						value: {
							ok: false,
							error: {
								code: "FERMENT_PAUSED",
								message: `Ferment "${current.name}" is paused. The user must resume with /ferment resume before any further ferment tool calls. Acknowledge the pause and wait — do NOT call ferment tools.`,
							},
						},
					}
				}
				const now = runtime.nowIso()
				const result = applyCommand(current, cmd, { now })
				if (!result.ok) return { write: false, value: { ok: false, error: result.error } }
				const events = commandToEvents(cmd, current, result.ferment, { now })
				return { write: true, ferment: result.ferment, events, value: { ok: true, ferment: result.ferment } }
			},
		)
		if (outcome.ok) {
			runtime.setActive(outcome.ferment)
			if (runtime.events) {
				try {
					emitFermentDomainEvent(runtime.events, cmd, outcome.ferment)
				} catch {
					// Domain event emission is best-effort — a subscriber failure must
					// never destabilize the state-machine persistence path.
				}
			}
		}
		return outcome
	}
}

export function applyAndPersist(fermentId: string, cmd: Command): ApplyOutcome {
	return createApplyAndPersist(defaultFermentRuntime)(fermentId, cmd)
}

/**
 * Convert any error with a `message` field into a tool-error result.
 * Centralized so error wording stays consistent across all tool handlers.
 */
export function failedToolResult(error: { message: string }, ferment?: Ferment) {
	return toolErr(withNextActionHint(error.message, ferment))
}
