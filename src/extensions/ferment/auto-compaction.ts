/**
 * Ferment auto-compaction.
 *
 * After every successful `complete_ferment_step` or `complete_ferment_phase`,
 * the tool handler records a pending compaction request in `state.ts`.
 * The `agent_end` hook calls `maybeTriggerFermentCompaction` to:
 *   1. Guard against double-trigger with an in-flight set.
 *   2. Resolve the next step/phase from the current ferment state.
 *   3. Build custom instructions highlighting the ferment plan.
 *   4. Fire `ctx.compact()` which summarises the session.
 *   5. On completion, append a hidden `ferment_stage_handoff` session entry
 *      so the next stage has all context it needs to resume cleanly.
 *
 * Failures warn via `ctx.ui.notify` and never block the pipeline.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { CompactionResult } from "@earendil-works/pi-coding-agent"
import { determineNextAction } from "../../ferment/engine.js"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import type { FermentRuntime } from "./runtime.js"
import type { PendingCompaction } from "./state.js"

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FermentHandoffDetails {
	fermentName: string
	fermentGoal?: string
	successCriteria?: string[]
	activePhaseName: string
	activePhaseGoal: string
	nextStepDescription?: string
	nextPhaseName?: string
	nextPhaseGoal?: string
	completedStepSummary?: string
	completedPhaseSummary?: string
	/** Number of tokens in the session before compaction was triggered (from CompactionResult.tokensBefore) */
	compactionTokensBefore?: number
}

// ─── In-flight guard ──────────────────────────────────────────────────────────

/** Prevents double-trigger when agent_end fires multiple times while compaction
 *  is already in progress for the same ferment. */
export const compactionInProgress = new Set<string>()

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a human-readable description of the next action from `determineNextAction`.
 * Returns undefined when no next action is found (ferment complete/abandoned).
 */
function buildNextActionDescription(
	ferment: Ferment,
): { nextStepDescription?: string; nextPhaseName?: string; nextPhaseGoal?: string } | undefined {
	const action = determineNextAction(ferment)
	if (!action) return undefined

	switch (action.kind) {
		case "start_step":
		case "complete_step":
		case "verify_step": {
			const phase = ferment.phases.find((p) => p.id === action.phaseId)
			const step = phase?.steps.find((s) => s.id === action.stepId)
			return {
				nextStepDescription: step ? `Step ${step.index}: ${step.description}` : action.stepId,
				nextPhaseName: phase?.name,
				nextPhaseGoal: phase?.goal,
			}
		}
		case "activate_phase": {
			const phase = ferment.phases.find((p) => p.id === action.phaseId)
			return {
				nextPhaseName: phase?.name ?? action.phaseId,
				nextPhaseGoal: phase?.goal,
			}
		}
		case "complete_phase": {
			const phase = ferment.phases.find((p) => p.id === action.phaseId)
			return {
				nextPhaseName: phase?.name,
				nextPhaseGoal: phase?.goal,
			}
		}
		default:
			return undefined
	}
}

/** Find the step that just completed (from the pending compaction's stepId). */
function findCompletedStep(ferment: Ferment, pending: PendingCompaction): Step | undefined {
	if (!pending.stepId) return undefined
	return findStepById(ferment, pending.phaseId, pending.stepId)
}

/** Find the phase that just completed (from the pending compaction's phaseId). */
function findCompletedPhase(ferment: Ferment, pending: PendingCompaction): Phase | undefined {
	return findPhaseById(ferment, pending.phaseId)
}

function findPhaseById(ferment: Ferment, phaseId: string): Phase | undefined {
	return ferment.phases.find((p) => p.id === phaseId)
}

function findStepById(ferment: Ferment, phaseId: string, stepId: string): Step | undefined {
	return findPhaseById(ferment, phaseId)?.steps.find((s) => s.id === stepId)
}

/** Build the custom instructions string passed to ctx.compact(). */
export function buildCustomInstructions(ferment: Ferment, pending: PendingCompaction): string {
	const completedPhase = findCompletedPhase(ferment, pending)
	const completedStep = findCompletedStep(ferment, pending)

	const nextAction = buildNextActionDescription(ferment)

	const lines: string[] = ["Preserve ferment plan details in the summary:"]

	lines.push(`- Ferment: ${ferment.name}${ferment.goal ? ` — ${ferment.goal}` : ""}`)

	if (ferment.successCriteria && ferment.successCriteria.length > 0) {
		lines.push(`- Success criteria: ${ferment.successCriteria.join("; ")}`)
	}

	if (completedPhase) {
		lines.push(`- Active phase: ${completedPhase.name} — ${completedPhase.goal}`)
	} else {
		const activePhase = ferment.phases.find((p) => p.status === "active")
		if (activePhase) {
			lines.push(`- Active phase: ${activePhase.name} — ${activePhase.goal}`)
		}
	}

	if (pending.kind === "step" && completedStep) {
		lines.push(
			`- Completed step: ${completedStep.description}${completedStep.summary ? ` (${completedStep.summary})` : ""}`,
		)
	} else if (pending.kind === "phase" && completedPhase) {
		lines.push(
			`- Completed phase: ${completedPhase.name}${completedPhase.summary ? ` (${completedPhase.summary})` : ""}`,
		)
	}

	if (nextAction?.nextStepDescription) {
		lines.push(`- Next up: ${nextAction.nextStepDescription}`)
	} else if (nextAction?.nextPhaseName) {
		lines.push(`- Next up: Phase "${nextAction.nextPhaseName}" — ${nextAction.nextPhaseGoal ?? "goal TBD"}`)
	} else {
		lines.push("- Next up: No further lifecycle action — ferment is terminal")
	}

	return lines.join("\n")
}

/** Build the FermentHandoffDetails payload written to the hidden session entry. */
export function buildHandoffDetails(
	result: CompactionResult,
	ferment: Ferment,
	pending: PendingCompaction,
): FermentHandoffDetails {
	const completedPhase = findCompletedPhase(ferment, pending)
	const completedStep = findCompletedStep(ferment, pending)
	const nextAction = buildNextActionDescription(ferment)
	const activePhase = ferment.phases.find((p) => p.status === "active") ?? completedPhase

	return {
		fermentName: ferment.name,
		fermentGoal: ferment.goal,
		successCriteria: ferment.successCriteria,
		activePhaseName: activePhase?.name ?? "unknown",
		activePhaseGoal: activePhase?.goal ?? "",
		nextStepDescription: nextAction?.nextStepDescription,
		nextPhaseName: nextAction?.nextPhaseName,
		nextPhaseGoal: nextAction?.nextPhaseGoal,
		completedStepSummary: completedStep?.summary,
		completedPhaseSummary: completedPhase?.summary,
		compactionTokensBefore: result.tokensBefore,
	}
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Check for a pending compaction request and fire `ctx.compact()` if one exists.
 *
 * Called from the `agent_end` event handler so the compaction does not interrupt
 * the agent loop that just finished. The in-flight guard prevents double-fire
 * when `agent_end` is dispatched multiple times while compaction is running.
 *
 * @param pi      - ExtensionAPI (for sendMessage and events)
 * @param ctx     - ExtensionContext (for compact, ui.notify)
 * @param runtime - FermentRuntime (for storage, active-id, pending-compaction state)
 */
export function maybeTriggerFermentCompaction(pi: ExtensionAPI, ctx: ExtensionContext, runtime: FermentRuntime): void {
	// Drain ALL pending compactions — not just the active ferment's. In automated
	// continuation mode the entire ferment runs in one long agent turn: agent_end
	// fires once at the end, after complete_ferment has already cleared
	// getActiveId(). Using drainPendingCompactions() ensures we catch every
	// step/phase that completed during the run, regardless of active-ferment state.
	const allPending = runtime.drainPendingCompactions()
	if (allPending.length === 0) return

	for (const pending of allPending) {
		triggerCompactionForPending(pi, ctx, runtime, pending)
	}
}

function triggerCompactionForPending(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: FermentRuntime,
	pending: PendingCompaction,
): void {
	const { fermentId } = pending

	// Guard: don't re-enter if compaction is already running for this ferment.
	if (compactionInProgress.has(fermentId)) return
	compactionInProgress.add(fermentId)

	// Reload the ferment from disk — the in-memory copy may be stale.
	const fermentMaybe = runtime.getStorage().get(fermentId)
	if (!fermentMaybe) {
		compactionInProgress.delete(fermentId)
		return
	}
	// Captured after the guard so the non-null type is visible inside closures.
	const ferment: Ferment = fermentMaybe

	const customInstructions = buildCustomInstructions(ferment, pending)

	/** Append the hidden handoff entry so the next stage always receives
	 *  plan + stage context, even when compaction is skipped (session too
	 *  small, already compacted, no model, etc.). */
	function appendHandoffEntry(result?: CompactionResult): void {
		const handoff = buildHandoffDetails(
			result ?? { summary: "", firstKeptEntryId: "", tokensBefore: 0 },
			ferment,
			pending,
		)
		pi.sendMessage(
			{
				customType: "ferment_stage_handoff",
				content: [{ type: "text", text: JSON.stringify(handoff) }],
				display: false,
				details: handoff,
			},
			{ triggerTurn: false },
		)
	}

	ctx.compact({
		customInstructions,
		onComplete: (result: CompactionResult) => {
			compactionInProgress.delete(fermentId)
			appendHandoffEntry(result)
		},
		onError: (error: Error) => {
			compactionInProgress.delete(fermentId)
			// Silently skip expected non-errors: session too small, already
			// compacted, cancelled. These are routine when steps are short.
			const isExpected =
				error.message.includes("too small") ||
				error.message.includes("Already compacted") ||
				error.message.includes("Compaction cancelled")
			if (!isExpected) {
				ctx.ui?.notify?.(`Stage compaction failed: ${error.message}`, "warning")
			}
			// Always append the handoff entry even when compaction fails/is skipped.
			appendHandoffEntry()
		},
	})
}
