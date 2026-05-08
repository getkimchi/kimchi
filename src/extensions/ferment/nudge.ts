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

export function maybeInjectAutoNudge(pi: ExtensionAPI): void {
	if (!isAutoModeEnabled()) return
	const f = getActive()
	if (!f) return
	const action = whatNext(f)
	// Skip terminal/idle states
	if (action.kind === "paused" || action.kind === "complete_ferment") return
	// Only nudge on transitions — not on every routine step completion. The planner
	// already has the next step in its context after complete_step returns.
	if (!TRANSITION_KINDS.has(action.kind)) return

	const activePhase = f.phases.find((p) => p.id === f.activePhaseId)
	const activeStep = activePhase?.steps.find((s) => s.status === "running" || s.status === "pending")
	const phaseInfo = activePhase ? ` · phase ${activePhase.index}/${f.phases.length} "${activePhase.name}"` : ""
	const stepInfo = activeStep ? ` · step ${activeStep.index}/${activePhase?.steps.length}` : ""
	const breadcrumb = `Auto-nudge [${action.kind}]: "${f.name}" [${f.status}]${phaseInfo}${stepInfo}`

	pi.appendEntry("ferment_breadcrumb", { text: breadcrumb })
	void pi.sendMessage(
		{
			customType: "ferment_automode_nudge",
			content: [{ type: "text", text: action.message }],
			display: false,
			details: { action: action.kind },
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
