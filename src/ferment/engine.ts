/**
 * Ferment Engine v4 — Progressive Refinement
 *
 * Reads the ferment JSON state and returns the next Action for the LLM.
 * Mode-aware: plan mode (coaching), exec mode (auto-advance), auto mode (mixed).
 *
 * Two output modes:
 * - `determineNextAction` — declarative, state-based. Returns a `DeclarativeAction`
 *   with a one-sentence reason. No prose instructions.
 * - `whatNext` — prose-driven (legacy). Returns `FermentAction` with LLM prose.
 *   Used by callers that need the full coaching message.
 */

import type { Ferment, FermentAction, Phase, Step } from "./types.js"

// ─── Declarative Action Types ─────────────────────────────────────────────────

export type DeclarativeAction =
	| { kind: "scope"; reason: string }
	| { kind: "activate_phase"; phaseId: string; reason: string }
	| { kind: "refine"; phaseId: string; reason: string }
	| { kind: "start_step"; phaseId: string; stepId: string; reason: string; canParallel: boolean }
	| { kind: "complete_step"; phaseId: string; stepId: string; reason: string }
	| { kind: "verify_step"; phaseId: string; stepId: string; reason: string }
	| { kind: "complete_phase"; phaseId: string; reason: string }
	| { kind: "pause"; reason: string }
	| { kind: "complete_ferment"; reason: string }
	| { kind: "recover_step"; phaseId: string; stepId: string; reason: string }
	| { kind: "recover_phase"; phaseId: string; reason: string }
	| { kind: "noop"; reason: string }

// ─── Main Entry Point ──────────────────────────────────────────────────────────

/**
 * Declarative next-action determination.
 * Reads ferment state and returns the next action without prose.
 * Reason is a one-sentence objective, not an instruction.
 */
export function determineNextAction(ferment: Ferment): DeclarativeAction {
	const active = findActivePhase(ferment)

	// Priority-ordered conditions (higher priority first)

	// 0. Terminal ferment status → complete_ferment
	if (ferment.status === "complete" || ferment.status === "abandoned") {
		return { kind: "complete_ferment", reason: `ferment is ${ferment.status}` }
	}

	// 1. No phases defined → scope (only if not paused)
	if (ferment.phases.length === 0) {
		if (ferment.status === "paused") {
			return { kind: "pause", reason: "ferment is paused" }
		}
		return { kind: "scope", reason: "collect goal, criteria, constraints, and phase breakdown" }
	}

	// 2. Ferment is paused
	if (ferment.status === "paused") {
		return { kind: "pause", reason: "ferment is paused" }
	}

	// 3. Active phase failed → recover (before all-terminal check)
	if (active && active.status === "failed") {
		return {
			kind: "recover_phase",
			phaseId: active.id,
			reason: "handle failed phase",
		}
	}

	// 4. All phases terminal → complete_ferment
	const allPhasesTerminal = ferment.phases.every(
		(p) => p.status === "completed" || p.status === "skipped" || p.status === "failed",
	)
	if (allPhasesTerminal) {
		return { kind: "complete_ferment", reason: `all ${ferment.phases.length} phases are terminal` }
	}

	// 5. No active phase, ferment is planned → activate first planned
	if (!active && ferment.status === "planned") {
		const next = findFirstPlannedPhase(ferment)
		if (next) {
			return {
				kind: "activate_phase",
				phaseId: next.id,
				reason: "activate the first planned phase",
			}
		}
	}

	// 6. Running but no active phase (recovered state)
	if (ferment.status === "running" && !active) {
		return { kind: "pause", reason: "no active phase, recovered state" }
	}

	// 7. Active phase has no steps → refine
	if (active && active.steps.length === 0) {
		return { kind: "refine", phaseId: active.id, reason: "populate the active phase with concrete steps" }
	}

	// 8. Steps with failures → recover_step first
	if (active) {
		const failedStep = active.steps.find((s) => s.status === "failed")
		if (failedStep) {
			return {
				kind: "recover_step",
				phaseId: active.id,
				stepId: failedStep.id,
				reason: "handle failed step",
			}
		}

		// 9. Steps pending → start first pending
		const nextStep = findNextStep(active)
		if (nextStep) {
			return {
				kind: "start_step",
				phaseId: active.id,
				stepId: nextStep.id,
				reason: "start the next pending step",
				canParallel: false,
			}
		}

		// 10. Step running → complete_step (SUGGESTION, LLM decides when)
		const runningStep = active.steps.find((s) => s.status === "running")
		if (runningStep) {
			return {
				kind: "complete_step",
				phaseId: active.id,
				stepId: runningStep.id,
				reason: "mark the running step as complete",
			}
		}

		// 11. All steps terminal → complete_phase
		const allStepsTerminal = active.steps.every(
			(s) => s.status === "done" || s.status === "skipped" || s.status === "verified" || s.status === "failed",
		)
		if (allStepsTerminal) {
			return {
				kind: "complete_phase",
				phaseId: active.id,
				reason: `mark phase ${active.index} as complete when all steps are terminal`,
			}
		}
	}

	// 12. Noop
	return { kind: "noop", reason: "no action needed" }
}

/**
 * Legacy prose-driven action. Prefer `determineNextAction` for new code.
 */
export function whatNext(ferment: Ferment): FermentAction {
	const action = determineNextAction(ferment)
	return toFermentAction(action, ferment)
}

function toFermentAction(action: DeclarativeAction, ferment: Ferment): FermentAction {
	// Helper to find phase/step from action
	const phase = "phaseId" in action ? ferment.phases.find((p) => p.id === action.phaseId) : undefined
	const step = phase && "stepId" in action ? phase.steps.find((s) => s.id === action.stepId) : undefined

	switch (action.kind) {
		case "scope":
			return { kind: "scope", message: buildScopeProse(ferment) }

		case "activate_phase":
			return {
				kind: "activate_phase",
				phaseId: action.phaseId,
				message: `Activate phase ${phase?.index}: "${phase?.name}"`,
			}

		case "refine":
			return {
				kind: "refine",
				phaseId: action.phaseId,
				message: `Break phase ${phase?.index} "${phase?.name}" into 3–6 concrete steps.`,
			}

		case "start_step":
			return {
				kind: "start_step",
				stepId: action.stepId,
				message: `Start step ${step?.index}: "${step?.description}"`,
			}

		case "complete_step":
			return {
				kind: "complete_step",
				stepId: action.stepId,
				message: `Complete step ${step?.index}: "${step?.description}"`,
			}

		case "verify_step":
			// FermentAction uses "verify" kind
			return {
				kind: "verify",
				stepId: action.stepId,
				message: `Verify step ${step?.index}: "${step?.description}"`,
			}

		case "complete_phase":
			return {
				kind: "complete_phase",
				phaseId: action.phaseId,
				message: `Mark phase ${phase?.index} "${phase?.name}" as complete.`,
			}

		case "pause":
			return { kind: "paused", message: "Ferment is paused." }

		case "complete_ferment":
			return {
				kind: "complete_ferment",
				message:
					ferment.status !== "running" && ferment.status !== "planned" && ferment.status !== "draft"
						? `Ferment is ${ferment.status}. All ${ferment.phases.length} phases complete.`
						: `All ${ferment.phases.length} phases complete. Mark ferment as complete.`,
			}

		case "recover_step":
			return {
				kind: "recover_step",
				phaseId: action.phaseId,
				stepId: action.stepId,
				message: `Step ${step?.index} "${step?.description}" failed.`,
			}

		case "recover_phase":
			return {
				kind: "recover_phase",
				phaseId: action.phaseId,
				message: `Phase ${phase?.index} "${phase?.name}" failed.`,
			}

		case "noop":
			// noop maps to paused with a "nothing to do" message
			return { kind: "paused", message: "Nothing to do." }
	}
}

function buildScopeProse(f: Ferment): string {
	const s = f.scoping
	const missing: string[] = []
	if (!s.goal) missing.push("goal")
	if (!s.criteria) missing.push("success criteria")
	if (!s.constraints) missing.push("constraints")
	if (!s.phases) missing.push("phase breakdown")

	if (missing.length === 0) {
		return `All scoping fields collected for ferment "${f.name}".`
	}

	return `Collect: ${missing.join(", ")}.`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function findFirstPlannedPhase(f: Ferment): Phase | undefined {
	return f.phases.find((p) => p.status === "planned")
}

export function isScopingComplete(f: Ferment): boolean {
	return !!(f.scoping.goal && f.scoping.criteria && f.scoping.constraints && f.scoping.phases)
}

export function getScopingProgress(f: Ferment): { answered: number; total: number } {
	const s = f.scoping
	let answered = 0
	if (s.goal) answered++
	if (s.criteria) answered++
	if (s.constraints) answered++
	if (s.phases) answered++
	return { answered, total: 4 }
}

function findActivePhase(f: Ferment): Phase | undefined {
	if (f.activePhaseId) {
		const byId = f.phases.find((p) => p.id === f.activePhaseId)
		// Only trust activePhaseId if the phase is actually in an active state;
		// fall back to status scan on data drift (e.g. recovered ferments).
		if (byId && (byId.status === "active" || byId.status === "failed")) return byId
	}
	return f.phases.find((p) => p.status === "active")
}

function findNextStep(p: Phase): Step | undefined {
	// Returns the first step that should be *started* next. Excludes terminal states
	// (done/skipped/verified/failed) AND running — a running step is the runningStep
	// branch's responsibility, not a candidate for start_step.
	return p.steps.find(
		(s) =>
			s.status !== "done" &&
			s.status !== "skipped" &&
			s.status !== "verified" &&
			s.status !== "failed" &&
			s.status !== "running",
	)
}
