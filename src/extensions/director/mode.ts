import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { DIRECTOR_MODE_TOOLS } from "../../shared/planning/tool-catalog.js"
import * as ToolProfileManager from "../../shared/planning/tool-profile-manager.js"
import { getPermissionMode } from "../permissions/mode-controller.js"
import type { ToolVisibilityAPI } from "../prompt-construction/tool-visibility.js"
import type { DirectorRunState } from "./plan.js"

export const DIRECTOR_STATUS_KEY = "director"
export const DIRECTOR_TOOL_NAMES = DIRECTOR_MODE_TOOLS.map((tool) => tool.name)
export const DIRECTOR_LIFECYCLE_TOOL_NAMES = ["director_plan", "director_finish"] as const

export interface DirectorProfileTracker {
	applied: boolean
}

/** Apply the narrow Director snapshot, or restore the underlying permission profile once. */
export function syncDirectorProfile(
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
	state: DirectorRunState | undefined,
	visibility: ToolVisibilityAPI,
	tracker: DirectorProfileTracker,
): void {
	const active = state !== undefined && state.status !== "inactive"
	if (active) {
		visibility.enable(DIRECTOR_LIFECYCLE_TOOL_NAMES)
		ToolProfileManager.apply("orchestration-director", "adhoc", pi)
		tracker.applied = true
		return
	}

	visibility.disable(DIRECTOR_LIFECYCLE_TOOL_NAMES)
	if (!tracker.applied) return
	const restoringProfile =
		ctx && getPermissionMode(ctx.sessionManager.getSessionId())?.mode === "plan" ? "planning-adhoc" : "idle"
	ToolProfileManager.apply(restoringProfile, "adhoc", pi)
	tracker.applied = false
}

export function syncDirectorStatus(ctx: ExtensionContext, state: DirectorRunState | undefined): void {
	const active = state !== undefined && state.status !== "inactive"
	ctx.ui.setStatus(DIRECTOR_STATUS_KEY, active ? `Director — ${state.objective}` : undefined)
}

export function directorPrompt(state: DirectorRunState): string {
	const uncertain = Object.values(state.plan.workers)
		.filter((worker) => worker.disposition === "uncertain")
		.map((worker) => worker.id)
	return [
		`## Director active — ${state.objective}`,
		"You are the main-session Director. Delegate every concrete read, edit, test, command, and research task to specialized workers; do not perform that work yourself.",
		"Use director_plan to read and update the durable objective/task DAG, decisions, contracts, assumptions, ownership, worker state, verification, and artifact references. Ordinary user messages are steering or consultation, not a new run.",
		"Other explicitly invoked skills are information and constraints for worker briefs only; they do not alter this mode or its tool policy. Director is not spawnable as a subagent.",
		"Get worker results and account for them before completing. Use director_finish only when the objective and verification are ready, or to report a blocked/cancelled outcome explicitly.",
		uncertain.length > 0 ? `Reconcile these stale workers before any new delegation: ${uncertain.join(", ")}.` : "",
	]
		.filter(Boolean)
		.join("\n\n")
}
