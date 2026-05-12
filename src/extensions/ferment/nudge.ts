/**
 * LLM nudges and post-mutation hooks.
 *
 * - `appendRefEntry`: writes a hidden session entry that survives compaction —
 *   used so resumed sessions can find the active ferment.
 * - `maybeInjectAutoNudge`: in auto mode, injects a "what's next" prompt into
 *   the next turn. Fires only on real transitions (not every routine step).
 * - `onStepCompleted` / `onPhaseCompleted`: helpers tools call after writing
 *   storage to re-sync the active ferment + nudge.
 *
 * All `pi.sendMessage` calls use `deliverAs: "followUp"` to avoid the
 * "agent is already processing" error when triggered from inside tool execute
 * handlers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { determineNextAction } from "../../ferment/engine.js"
import type { DeclarativeAction } from "../../ferment/engine.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"

export function appendRefEntry(pi: ExtensionAPI, fermentId: string): void {
	void pi.sendMessage({
		customType: "ferment_reference",
		content: [{ type: "text", text: `active: ${fermentId}` }],
		display: false,
		details: { fermentId },
	})
}

const TRANSITION_KINDS = new Set([
	"scope",
	"refine",
	"activate_phase",
	"complete_phase",
	"recover_step",
	"recover_phase",
])

/**
 * Compose an imperative resume message from a DeclarativeAction.
 *
 * The engine's `determineNextAction` returns mode-aware structured actions.
 * After /auto we want the planner to act, not to ask. This helper keys off
 * the action *kind* and emits a directive that maps cleanly to a tool call.
 *
 * Mapping action.kind → expected next tool call:
 *   start_step       → start_step + spawn subagent
 *   refine           → refine_phase
 *   activate_phase   → activate_phase
 *   complete_phase   → complete_phase
 *   recover_step     → fail_step / skip_step / start_step (host-decides)
 *   recover_phase    → activate_phase / skip_phase, or ask user for /ferment abandon
 */
function buildResumeNudgeMessage(
	action: DeclarativeAction,
	fermentId: string,
	phaseId?: string,
	stepId?: string,
): string {
	const preamble =
		"RESUMING ferment after /auto. The user has confirmed they want execution to continue — take the next action now."
	switch (action.kind) {
		case "start_step":
			return `${preamble}\n\nAction: call start_step with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""}${stepId ? `, step_id "${stepId}"` : ""}, then spawn a subagent worker for that step. When the subagent returns, call complete_step with its summary.`
		case "refine":
			return `${preamble}\n\nAction: call refine_phase with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""} and 3–6 concrete steps for this phase.`
		case "activate_phase":
			return `${preamble}\n\nAction: call activate_phase with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""}.`
		case "complete_phase":
			return `${preamble}\n\nAction: call complete_phase with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""} and a one-paragraph summary.`
		case "recover_step":
			return `${preamble}\n\nThe step previously failed. Decide based on the failure: call start_step to retry, skip_step to bypass, or fail_step to mark it permanently failed. Pick one and call it now.`
		case "recover_phase":
			return `${preamble}\n\nThe phase previously failed. Decide based on the failure: call activate_phase to retry, call skip_phase to bypass, or ask the user to run /ferment abandon if the ferment should stop. Pick a tool call now unless abandonment is required.`
		case "scope":
			return `${preamble}\n\nAction: continue scoping — ${action.reason}.`
		case "complete_step":
			return `${preamble}\n\nAction: call complete_step with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""}${stepId ? `, step_id "${stepId}"` : ""}.`
		case "verify_step":
			return `${preamble}\n\nAction: call verify_step with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""}${stepId ? `, step_id "${stepId}"` : ""}.`
		case "pause":
		case "complete_ferment":
		case "noop":
			return `${preamble}\n\nReason: ${action.reason}`
	}
}

/**
 * Inject an auto-mode nudge into the next agent turn.
 *
 * `opts.force` skips the routine-noise filter — used by /auto resume so the
 * planner always gets a kick when the user explicitly asks to continue.
 * The default (force=false) only nudges on real *transitions* to avoid
 * burning a turn after every routine step completion.
 */
export function maybeInjectAutoNudge(
	pi: ExtensionAPI,
	opts: { force?: boolean } = {},
	runtime: FermentRuntime = defaultFermentRuntime,
): void {
	if (!runtime.isAutoModeEnabled()) return
	const f = runtime.getActive()
	if (!f) return
	const action = determineNextAction(f)
	// Skip terminal/idle states even when forced — there's nothing to do.
	if (action.kind === "pause" || action.kind === "complete_ferment" || action.kind === "noop") return
	// Only nudge on transitions — not on every routine step completion. The planner
	// already has the next step in its context after complete_step returns. The
	// `force` option overrides this to support explicit /auto resume.
	if (!opts.force && !TRANSITION_KINDS.has(action.kind)) return

	const actionPhase = "phaseId" in action ? f.phases.find((p) => p.id === action.phaseId) : undefined
	const activePhase = f.phases.find((p) => p.id === f.activePhaseId)
	const displayPhase = actionPhase ?? activePhase
	const activeStep = activePhase?.steps.find((s) => s.status === "running" || s.status === "pending")
	const phaseInfo = displayPhase ? ` · phase ${displayPhase.index}/${f.phases.length} "${displayPhase.name}"` : ""
	const stepInfo = activeStep ? ` · step ${activeStep.index}/${activePhase?.steps.length}` : ""
	const tag = opts.force ? "Resume" : "Auto-nudge"
	const breadcrumb = `${tag} [${action.kind}]: "${f.name}" [${f.status}]${phaseInfo}${stepInfo}`

	// Compose the message from the structured action rather than passing through
	// the engine's prose. The reason field provides a one-sentence objective.
	const messageText = opts.force
		? buildResumeNudgeMessage(action, f.id, displayPhase?.id, activeStep?.id)
		: `${action.kind}: ${action.reason}`

	pi.appendEntry("ferment_breadcrumb", { text: breadcrumb })
	void pi.sendMessage(
		{
			customType: "ferment_automode_nudge",
			content: [{ type: "text", text: messageText }],
			display: false,
			details: { action: action.kind, force: opts.force ?? false },
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	)
}

export function onStepCompleted(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	const id = runtime.getActiveId()
	if (!id) return
	const fresh = runtime.getStorage().get(id)
	if (fresh) {
		runtime.setActive(fresh)
		maybeInjectAutoNudge(pi, {}, runtime)
	}
}

export function onPhaseCompleted(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	// Refresh the in-memory active ferment cache after the storage write. The agent
	// drives state — no silent activate_phase here. Prior versions auto-advanced
	// the next planned phase in exec mode, which left the FSM in PHASE_ACTIVE
	// behind the agent's back and caused every subsequent agent-initiated
	// activate_phase to be rejected.
	const id = runtime.getActiveId()
	if (!id) return
	const fresh = runtime.getStorage().get(id)
	if (fresh) {
		runtime.setActive(fresh)
		maybeInjectAutoNudge(pi, {}, runtime)
	}
}
