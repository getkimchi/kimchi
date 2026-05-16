/**
 * LLM nudges and post-mutation hooks.
 *
 * - `appendRefEntry`: writes a hidden session entry that survives compaction —
 *   used so resumed sessions can find the active ferment.
 * - `injectResumeAutoNudge`: injects a "what's next" prompt for explicit
 *   resume flows such as /auto.
 * - `maybeInjectReactiveAutoNudge`: in auto mode, injects a "what's next"
 *   prompt only after an assistant turn stalls without tool calls.
 * - `onStepCompleted` / `onPhaseCompleted`: stable post-mutation hooks tools
 *   call after writing storage. Today they re-sync active ferment state; keep
 *   callers on the hook so future post-mutation logic has one place to live.
 *
 * All `pi.sendMessage` calls use `deliverAs: "followUp"` to avoid the
 * "agent is already processing" error when triggered from inside tool execute
 * handlers.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { determineNextAction } from "../../ferment/engine.js"
import type { DeclarativeAction } from "../../ferment/engine.js"
import type { Ferment } from "../../ferment/types.js"
import { formatActionNudgeLine } from "./action-tool-names.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"

export function appendRefEntry(pi: ExtensionAPI, fermentId: string): void {
	void pi.sendMessage({
		customType: "ferment_reference",
		content: [{ type: "text", text: `active: ${fermentId}` }],
		display: false,
		details: { fermentId },
	})
}

const TERMINAL_ACTION_KINDS = new Set(["pause", "complete_ferment", "noop"])
const MAX_CONSECUTIVE_REACTIVE_NUDGES = 3
const reactiveNudgeCounts = new Map<string, number>()

export function resetReactiveAutoNudgeCount(fermentId: string): void {
	reactiveNudgeCounts.delete(fermentId)
}

export function resetAllReactiveAutoNudgeCounts(): void {
	reactiveNudgeCounts.clear()
}

export function refreshActiveFermentFromStorage(runtime: FermentRuntime): Ferment | undefined {
	const id = runtime.getActiveId()
	if (!id) return undefined
	const fresh = runtime.getStorage().get(id)
	if (fresh) runtime.setActive(fresh)
	return fresh
}

/**
 * Compose an imperative resume message from a DeclarativeAction.
 *
 * The engine's `determineNextAction` returns mode-aware structured actions.
 * After /auto we want the planner to act, not to ask. This helper keys off
 * the action *kind* and emits a directive that maps cleanly to a tool call.
 *
 * Mapping action.kind → expected next tool call:
 *   start_step       → start_ferment_step + spawn subagent
 *   refine           → refine_ferment_phase
 *   activate_phase   → activate_ferment_phase
 *   complete_phase   → complete_ferment_phase
 *   recover_step     → fail_ferment_step / skip_ferment_step / start_ferment_step (host-decides)
 *   recover_phase    → activate_ferment_phase / skip_ferment_phase, or ask user for /ferment abandon
 */
export function buildAutoNudge(
	action: DeclarativeAction,
	fermentId: string,
	phaseId?: string,
	stepId?: string,
): string {
	const preamble =
		"RESUMING ferment after /auto. The user has confirmed they want execution to continue — take the next action now."
	switch (action.kind) {
		case "start_step":
			return `${preamble}\n\nAction: call start_ferment_step with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""}${stepId ? `, step_id "${stepId}"` : ""}, then spawn a subagent worker for that step. When the subagent returns, call complete_ferment_step with its summary.`
		case "refine":
			return `${preamble}\n\nAction: call refine_ferment_phase with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""} and 3–6 concrete steps for this phase.`
		case "activate_phase":
			return `${preamble}\n\nAction: call activate_ferment_phase with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""}.`
		case "complete_phase":
			return `${preamble}\n\nAction: call complete_ferment_phase with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""} and a one-paragraph summary.`
		case "recover_step":
			return `${preamble}\n\nThe step previously failed. Decide based on the failure: call start_ferment_step to retry, skip_ferment_step to bypass, or fail_ferment_step to mark it permanently failed. Pick one and call it now.`
		case "recover_phase":
			return `${preamble}\n\nThe phase previously failed. Decide based on the failure: call activate_ferment_phase to retry, call skip_ferment_phase to bypass, or ask the user to run /ferment abandon if the ferment should stop. Pick a tool call now unless abandonment is required.`
		case "scope":
			return `${preamble}\n\nAction: continue scoping — ${action.reason}.`
		case "complete_step":
			return `${preamble}\n\nAction: call complete_ferment_step with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""}${stepId ? `, step_id "${stepId}"` : ""}.`
		case "verify_step":
			return `${preamble}\n\nAction: call verify_ferment_step with ferment_id "${fermentId}"${phaseId ? `, phase_id "${phaseId}"` : ""}${stepId ? `, step_id "${stepId}"` : ""}.`
		case "pause":
		case "complete_ferment":
		case "noop":
			return `${preamble}\n\nReason: ${action.reason}`
	}
}

export function sendAutoNudge(
	pi: ExtensionAPI,
	f: Ferment,
	action: DeclarativeAction,
	opts: { force?: boolean; tag?: string } = {},
): void {
	const actionPhase = "phaseId" in action ? f.phases.find((p) => p.id === action.phaseId) : undefined
	const activePhase = f.phases.find((p) => p.id === f.activePhaseId)
	const displayPhase = actionPhase ?? activePhase
	const activeStep = activePhase?.steps.find((s) => s.status === "running" || s.status === "pending")
	const phaseInfo = displayPhase ? ` · phase ${displayPhase.index}/${f.phases.length} "${displayPhase.name}"` : ""
	const stepInfo = activeStep ? ` · step ${activeStep.index}/${activePhase?.steps.length}` : ""
	const tag = opts.tag ?? (opts.force ? "Resume" : "Auto-nudge")
	const breadcrumb = `${tag} [${action.kind}]: "${f.name}" [${f.status}]${phaseInfo}${stepInfo}`

	const messageText = opts.force
		? buildAutoNudge(action, f.id, displayPhase?.id, activeStep?.id)
		: formatActionNudgeLine(action)

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

/**
 * Inject an auto-mode nudge into the next agent turn.
 *
 * `opts.force` skips the routine-noise filter — used by /auto resume so the
 * planner always gets a kick when the user explicitly asks to continue.
 * The default (force=false) only nudges on real *transitions* to avoid
 * burning a turn after every routine step completion.
 */
export function injectResumeAutoNudge(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	if (!runtime.isAutoModeEnabled()) return
	const f = runtime.getActive()
	if (!f) return
	const action = determineNextAction(f)
	// Skip terminal/idle states even when forced — there's nothing to do.
	if (TERMINAL_ACTION_KINDS.has(action.kind)) return

	resetReactiveAutoNudgeCount(f.id)
	sendAutoNudge(pi, f, action, { force: true })
}

export function maybeInjectReactiveAutoNudge(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	if (!runtime.isAutoModeEnabled()) return
	const id = runtime.getActiveId()
	if (!id) return
	const fresh = refreshActiveFermentFromStorage(runtime)
	const inactive = !fresh || fresh.status === "complete" || fresh.status === "abandoned"
	if (inactive) runtime.setActive(undefined)
	if (inactive || fresh.status === "paused") {
		resetReactiveAutoNudgeCount(id)
		return
	}
	const action = determineNextAction(fresh)
	if (TERMINAL_ACTION_KINDS.has(action.kind)) return

	const count = reactiveNudgeCounts.get(fresh.id) ?? 0
	if (count >= MAX_CONSECUTIVE_REACTIVE_NUDGES) {
		pi.appendEntry("ferment_breadcrumb", {
			text: `Auto-nudge suppressed after ${count} consecutive text-only assistant turns for "${fresh.name}".`,
		})
		return
	}

	reactiveNudgeCounts.set(fresh.id, count + 1)
	sendAutoNudge(pi, fresh, action, { tag: "Reactive auto-nudge" })
}

export function onStepCompleted(runtime: FermentRuntime = defaultFermentRuntime): void {
	refreshActiveFermentFromStorage(runtime)
}

export function onPhaseCompleted(runtime: FermentRuntime = defaultFermentRuntime): void {
	// Refresh the in-memory active ferment cache after the storage write. The agent
	// drives state; no silent activate_ferment_phase here. Prior versions auto-advanced
	// the next planned phase in exec mode, which left the FSM in PHASE_ACTIVE
	// behind the agent's back and caused every subsequent agent-initiated
	// activate_ferment_phase to be rejected.
	refreshActiveFermentFromStorage(runtime)
}
