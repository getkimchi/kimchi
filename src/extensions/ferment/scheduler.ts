import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getScopingProgress } from "../../ferment/engine.js"
import type { DeclarativeAction } from "../../ferment/engine.js"
import type { Ferment } from "../../ferment/types.js"
import { formatActionNudgeLine } from "./action-tool-names.js"
import { decideContinuation } from "./continuation.js"
import type { FermentRuntime } from "./runtime.js"

export interface ScheduleNextFermentActionOptions {
	allowManualPhaseBoundary?: boolean
	tag?: string
	deliverAsFollowUp?: boolean
}

export interface ScheduleFermentWakeUpOptions {
	allowManualPhaseBoundary?: boolean
	deliverAsFollowUp?: boolean
	fermentId?: string
	tag?: string
}

export function buildFermentWakeUpNudge(ferment: Ferment, action: DeclarativeAction): string {
	const prefix = `CONTINUING ferment "${ferment.name}" (${ferment.id}).`
	switch (action.kind) {
		case "activate_phase":
			return `${prefix} Call activate_ferment_phase with ferment_id "${ferment.id}" and phase_id "${action.phaseId}".`
		case "refine":
			return `${prefix} Call refine_ferment_phase with ferment_id "${ferment.id}" and phase_id "${action.phaseId}".`
		case "start_step":
			return `${prefix} Call start_ferment_step with ferment_id "${ferment.id}", phase_id "${action.phaseId}", and step_id "${action.stepId}".`
		case "complete_step":
			return `${prefix} Call complete_ferment_step with ferment_id "${ferment.id}", phase_id "${action.phaseId}", and step_id "${action.stepId}" when the step work is complete.`
		case "verify_step":
			return `${prefix} Call verify_ferment_step with ferment_id "${ferment.id}", phase_id "${action.phaseId}", and step_id "${action.stepId}".`
		case "complete_phase":
			return `${prefix} Call complete_ferment_phase with ferment_id "${ferment.id}" and phase_id "${action.phaseId}" when the phase is complete.`
		default:
			return `${prefix} ${formatActionNudgeLine(action)}.`
	}
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

	const baseMsg = formatActionNudgeLine(action)
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
