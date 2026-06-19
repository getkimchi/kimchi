import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getScopingProgress } from "../../ferment/engine.js"
import type { DeclarativeAction } from "../../ferment/engine.js"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { formatActionNudgeLine } from "./action-tool-names.js"
import { decideContinuation } from "./continuation.js"
import type { FermentRuntime } from "./runtime.js"

export interface ScheduleNextFermentActionOptions {
	allowManualPhaseBoundary?: boolean
	treatCompleteFermentAsContinue?: boolean
	tag?: string
	deliverAsFollowUp?: boolean
}

export interface ScheduleFermentWakeUpOptions {
	allowManualPhaseBoundary?: boolean
	deliverAsFollowUp?: boolean
	fermentId?: string
	tag?: string
}

// ─── Contextual nudge builder ─────────────────────────────────────────────────
// Produces a fully-specified, action-specific prompt that tells the agent
// exactly what tool call to make next, including the concrete step description,
// verify command, and phase context so it never has to guess.

function phaseContext(ferment: Ferment, phaseId: string): { phase: Phase | undefined; phaseLabel: string } {
	const phase = ferment.phases.find((p) => p.id === phaseId)
	const phaseLabel = phase
		? `phase ${phase.index}/${ferment.phases.length} "${phase.name}"${phase.goal && phase.goal !== phase.name ? ` (goal: ${phase.goal})` : ""}`
		: `phase ${phaseId}`
	return { phase, phaseLabel }
}

function stepContext(phase: Phase | undefined, stepId: string): { step: Step | undefined; stepLabel: string } {
	const step = phase?.steps.find((s) => s.id === stepId)
	const stepLabel = step ? `step ${step.index}/${phase?.steps.length} — "${step.description}"` : `step ${stepId}`
	return { step, stepLabel }
}

/**
 * Builds a specific, context-rich nudge message for the given action.
 *
 * Every branch names the exact tool, the exact IDs, and the concrete
 * description/goal so the agent knows what work belongs to this action
 * without having to re-read the plan.
 */
export function buildContextualNudge(ferment: Ferment, action: DeclarativeAction): string {
	const fid = ferment.id
	const fname = ferment.name

	switch (action.kind) {
		case "activate_phase": {
			const { phase, phaseLabel } = phaseContext(ferment, action.phaseId)
			const phaseGoal = phase?.goal ? `\n  Phase goal: ${phase.goal}` : ""
			return (
				`Ferment "${fname}" is running — call activate_ferment_phase now.\n` +
				`  ferment_id: "${fid}"\n` +
				`  phase_id:   "${action.phaseId}"  (${phaseLabel})${phaseGoal}`
			)
		}

		case "refine": {
			const { phaseLabel } = phaseContext(ferment, action.phaseId)
			return (
				`Ferment "${fname}" needs steps — call refine_ferment_phase to populate ${phaseLabel}.\n` +
				`  ferment_id: "${fid}"\n` +
				`  phase_id:   "${action.phaseId}"`
			)
		}

		case "start_step": {
			const { phase, phaseLabel } = phaseContext(ferment, action.phaseId)
			const { step, stepLabel } = stepContext(phase, action.stepId)
			const verifyHint = step?.verification?.command ? `\n  Verify command: ${step.verification.command}` : ""
			return (
				`Ferment "${fname}" has pending work — call start_ferment_step to begin ${stepLabel}.\n` +
				`  ferment_id: "${fid}"\n` +
				`  phase_id:   "${action.phaseId}"  (${phaseLabel})\n` +
				`  step_id:    "${action.stepId}"${verifyHint}`
			)
		}

		case "complete_step": {
			const { phase, phaseLabel } = phaseContext(ferment, action.phaseId)
			const { step, stepLabel } = stepContext(phase, action.stepId)
			const verifyHint = step?.verification?.command ? `\n  Verify command: ${step.verification.command}` : ""
			return (
				`Ferment "${fname}" has a running step — call complete_ferment_step once the work for ${stepLabel} is done.\n` +
				`  ferment_id: "${fid}"\n` +
				`  phase_id:   "${action.phaseId}"  (${phaseLabel})\n` +
				`  step_id:    "${action.stepId}"${verifyHint}`
			)
		}

		case "verify_step": {
			const { phase, phaseLabel } = phaseContext(ferment, action.phaseId)
			const { step, stepLabel } = stepContext(phase, action.stepId)
			const verifyHint = step?.verification?.command ? `\n  Verify command: ${step.verification.command}` : ""
			return (
				`Ferment "${fname}" needs verification — call verify_ferment_step for ${stepLabel}.\n` +
				`  ferment_id: "${fid}"\n` +
				`  phase_id:   "${action.phaseId}"  (${phaseLabel})\n` +
				`  step_id:    "${action.stepId}"${verifyHint}`
			)
		}

		case "complete_phase": {
			const { phase, phaseLabel } = phaseContext(ferment, action.phaseId)
			const doneSteps =
				phase?.steps.filter((s) => s.status === "done" || s.status === "verified" || s.status === "skipped").length ?? 0
			const totalSteps = phase?.steps.length ?? 0
			return (
				`Ferment "${fname}" — all steps complete. Call complete_ferment_phase for ${phaseLabel} (${doneSteps}/${totalSteps} steps done).\n` +
				`  ferment_id: "${fid}"\n` +
				`  phase_id:   "${action.phaseId}"`
			)
		}

		case "recover_step": {
			const { phase, phaseLabel } = phaseContext(ferment, action.phaseId)
			const { stepLabel } = stepContext(phase, action.stepId)
			return `Ferment "${fname}" has a failed step — diagnose and recover ${stepLabel}.\n  ferment_id: "${fid}"\n  phase_id:   "${action.phaseId}"  (${phaseLabel})\n  step_id:    "${action.stepId}"\n  Use skip_ferment_step or restart the step via start_ferment_step after fixing the issue.`
		}

		case "recover_phase": {
			const { phaseLabel } = phaseContext(ferment, action.phaseId)
			return `Ferment "${fname}" has a failed phase — diagnose and recover ${phaseLabel}.\n  ferment_id: "${fid}"\n  phase_id:   "${action.phaseId}"\n  Use activate_ferment_phase to retry the failed phase, skip_ferment_phase to bypass it, or ask the user to run /ferment abandon if the ferment should stop.`
		}

		default:
			return formatActionNudgeLine(action)
	}
}

/** @deprecated Use buildContextualNudge instead — kept for callers that have
 *  not yet been migrated. Produces bare tool-name + reason with no IDs or
 *  step description. */
export function buildFermentWakeUpNudge(ferment: Ferment, action: DeclarativeAction): string {
	return buildContextualNudge(ferment, action)
}

function freshFerment(runtime: FermentRuntime, fermentId?: string): Ferment | undefined {
	const id = fermentId ?? runtime.getActiveId()
	const cached = runtime.getActive()
	const fresh = id ? (runtime.getStorage().get(id) ?? (cached?.id === id ? cached : undefined)) : cached
	if (fresh) runtime.setActive(fresh)
	return fresh
}

function shouldSuppressHiddenNudge(action: DeclarativeAction): boolean {
	return action.kind === "scope"
}

export function scheduleNextFermentAction(
	pi: ExtensionAPI,
	ferment: Ferment,
	runtime: FermentRuntime,
	opts: ScheduleNextFermentActionOptions = {},
): void {
	const decision = decideContinuation(ferment, runtime.getContinuationPolicy(), opts)
	if (decision.type === "wait_manual_boundary") {
		pi.appendEntry("ferment_breadcrumb", {
			text: `Manual policy waiting at phase boundary for "${ferment.name}".`,
		})
		return
	}
	if (decision.type !== "continue") return

	const action = decision.action
	if (shouldSuppressHiddenNudge(action)) return
	const actionPhase = "phaseId" in action ? ferment.phases.find((p) => p.id === action.phaseId) : undefined
	const activePhase = ferment.phases.find((p) => p.id === ferment.activePhaseId)
	const displayPhase = actionPhase ?? activePhase
	const activeStep = activePhase?.steps.find((s) => s.status === "running" || s.status === "pending")
	const phaseInfo = displayPhase ? ` · phase ${displayPhase.index}/${ferment.phases.length} "${displayPhase.name}"` : ""
	const stepInfo = activeStep ? ` · step ${activeStep.index}/${activePhase?.steps.length}` : ""
	const tag = opts.tag ?? "Continuation"
	const breadcrumb = `${tag} [${action.kind}]: "${ferment.name}" [${ferment.status}]${phaseInfo}${stepInfo}`

	const baseMsg = buildContextualNudge(ferment, action)
	const scopeProgress = getScopingProgress(ferment)
	const interruptedPrefix =
		ferment.status === "running"
			? `RESUMING ferment "${ferment.name}" — the previous session was interrupted. Pick up the work immediately. Do NOT explain or summarize — execute the next action below.\n\n`
			: ""
	const messageText = `${interruptedPrefix}${baseMsg}`

	pi.appendEntry("ferment_breadcrumb", {
		text: `${breadcrumb} · policy ${runtime.getContinuationPolicy()} · scoping ${scopeProgress.answered}/${scopeProgress.total}`,
	})
	void pi.sendMessage(
		{
			customType: "ferment_continuation_nudge",
			content: [{ type: "text", text: messageText }],
			display: false,
			details: { action: action.kind },
		},
		opts.deliverAsFollowUp ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true },
	)
}

export function scheduleFermentWakeUp(
	pi: ExtensionAPI,
	runtime: FermentRuntime,
	opts: ScheduleFermentWakeUpOptions = {},
): void {
	const ferment = freshFerment(runtime, opts.fermentId)
	if (!ferment || ferment.status === "complete" || ferment.status === "abandoned" || ferment.status === "paused") {
		if (ferment?.status === "complete" || ferment?.status === "abandoned") runtime.setActive(undefined)
		return
	}

	const decision = decideContinuation(ferment, runtime.getContinuationPolicy(), opts)
	if (decision.type !== "continue") return
	if (shouldSuppressHiddenNudge(decision.action)) return

	const scopeProgress = getScopingProgress(ferment)
	const tag = opts.tag ?? "Wake-up"
	pi.appendEntry("ferment_breadcrumb", {
		text: `${tag} [${decision.action.kind}]: "${ferment.name}" [${ferment.status}] · policy ${runtime.getContinuationPolicy()} · scoping ${scopeProgress.answered}/${scopeProgress.total}`,
	})
	void pi.sendMessage(
		{
			customType: "ferment_continuation_nudge",
			content: [{ type: "text", text: buildFermentWakeUpNudge(ferment, decision.action) }],
			display: false,
			details: { action: "wake_up", expectedAction: decision.action.kind },
		},
		opts.deliverAsFollowUp ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true },
	)
}
