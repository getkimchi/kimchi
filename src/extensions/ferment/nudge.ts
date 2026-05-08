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
import { findFirstPlannedPhase, whatNext } from "../../ferment/engine.js"
import type { FermentAction } from "../../ferment/types.js"
import { isExecMode } from "./modes.js"
import { getActive, getActiveId, getStorage, isAutoModeEnabled, setActive } from "./state.js"

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
 * Compose an imperative resume message from a structured FermentAction.
 *
 * The engine's `whatNext` returns mode-aware prose — fine for plan-mode
 * coaching ("ask the user to confirm before starting"), but wrong after the
 * user has explicitly typed /auto. After resume we want the planner to act,
 * not to ask. This helper keys off the action *kind* (a structural field, not
 * prose) and emits a directive that maps cleanly to a tool call.
 *
 * Mapping action.kind → expected next tool call:
 *   start_step       → start_step + spawn subagent
 *   refine           → refine_phase
 *   activate_phase   → activate_phase
 *   complete_phase   → complete_phase
 *   recover_step     → fail_step / skip_step / start_step (host-decides)
 *   recover_phase    → activate_phase / skip_phase
 */
function buildResumeNudgeMessage(action: FermentAction, fermentId: string, phaseId?: string, stepId?: string): string {
	const preamble = `RESUMING ferment after /auto. The user has confirmed they want execution to continue — do NOT ask "Ready to execute this step?" or any similar question. Take the next action below as a tool call now.`
	switch (action.kind) {
		case "start_step":
			return `${preamble}\n\nNext action: call start_step with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""}${stepId ? `, step_id "${stepId}"` : ""}, then spawn a subagent worker for that step. When the subagent returns, call complete_step with its summary.`
		case "refine":
			return `${preamble}\n\nNext action: call refine_phase with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""} and 3–6 concrete steps for this phase. After refining, call start_step on step-1.`
		case "activate_phase":
			return `${preamble}\n\nNext action: call activate_phase with ferment_id "${fermentId}"${"phaseId" in action ? `, phase_id "${action.phaseId}"` : ""}.`
		case "complete_phase":
			return `${preamble}\n\nNext action: call complete_phase with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""} and a one-paragraph summary of what was accomplished.`
		case "recover_step":
			return `${preamble}\n\nThe step previously failed. Decide based on the failure: call start_step to retry, skip_step to bypass, or fail_step to mark it permanently failed. Pick one and call it now.`
		case "recover_phase":
			return `${preamble}\n\nThe phase previously failed. Decide based on the failure: call activate_phase to retry, or skip_phase to bypass. Pick one and call it now.`
		case "scope":
		case "verify":
		case "complete_step":
		case "paused":
		case "complete_ferment":
			// These shouldn't reach here under normal /auto flow, but fall through
			// to the engine's prose if they do. The pause/complete cases are
			// already filtered out at the top of maybeInjectAutoNudge.
			return action.message
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
export function maybeInjectAutoNudge(pi: ExtensionAPI, opts: { force?: boolean } = {}): void {
	if (!isAutoModeEnabled()) return
	const f = getActive()
	if (!f) return
	const action = whatNext(f)
	// Skip terminal/idle states even when forced — there's nothing to do.
	if (action.kind === "paused" || action.kind === "complete_ferment") return
	// Only nudge on transitions — not on every routine step completion. The planner
	// already has the next step in its context after complete_step returns. The
	// `force` option overrides this to support explicit /auto resume.
	if (!opts.force && !TRANSITION_KINDS.has(action.kind)) return

	const activePhase = f.phases.find((p) => p.id === f.activePhaseId)
	const activeStep = activePhase?.steps.find((s) => s.status === "running" || s.status === "pending")
	const phaseInfo = activePhase ? ` · phase ${activePhase.index}/${f.phases.length} "${activePhase.name}"` : ""
	const stepInfo = activeStep ? ` · step ${activeStep.index}/${activePhase?.steps.length}` : ""
	const tag = opts.force ? "Resume" : "Auto-nudge"
	const breadcrumb = `${tag} [${action.kind}]: "${f.name}" [${f.status}]${phaseInfo}${stepInfo}`

	// Compose the message from the structured action rather than passing through
	// the engine's mode-aware prose. The engine's plan-mode text says "ask the
	// user to confirm" — fine for casual coaching but wrong for explicit /auto
	// resume, where the user has already confirmed by typing the command. We
	// build an imperative message keyed off action.kind so the planner takes
	// the right tool call regardless of the engine's mode-flavored prose.
	const messageText = opts.force
		? buildResumeNudgeMessage(action, f.id, activePhase?.id, activeStep?.id)
		: action.message

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

export function onStepCompleted(pi: ExtensionAPI): void {
	const id = getActiveId()
	if (!id) return
	const fresh = getStorage().get(id)
	if (fresh) {
		setActive(fresh)
		maybeInjectAutoNudge(pi)
	}
}

export function onPhaseCompleted(pi: ExtensionAPI): void {
	const id = getActiveId()
	if (!id) return
	const fresh = getStorage().get(id)
	if (fresh) {
		setActive(fresh)
		// Auto-advance only in exec mode — auto/plan modes leave activation to the planner
		if (isExecMode()) {
			const next = findFirstPlannedPhase(fresh)
			if (next) {
				const s = getStorage()
				const r = s.activatePhase(fresh.id, next.id)
				if (r) setActive(r)
			}
		}
		maybeInjectAutoNudge(pi)
	}
}
