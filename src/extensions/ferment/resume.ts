import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { determineNextAction, getScopingProgress } from "../../ferment/engine.js"
import type { Ferment } from "../../ferment/types.js"
import { formatActionNudgeLine } from "./action-tool-names.js"
import { appendRefEntry } from "./nudge.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { scheduleFermentWakeUp } from "./scheduler.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import { setActiveFermentAndApplyProfile } from "./tool-scope.js"
import { checkWorktree } from "./worktree.js"

/**
 * Load a ferment as the active one without engaging the planner.
 * Used by the F27 resume banner when the user chooses "Leave paused":
 * commands like /auto and /progress should work, but the LLM should not
 * automatically resume.
 */
export function loadFermentSilently(
	pi: ExtensionAPI,
	fermentId: string,
	runtime: FermentRuntime = defaultFermentRuntime,
): Ferment | undefined {
	const storage = runtime.getStorage()
	const existing = storage.get(fermentId)
	if (!existing) {
		setActiveFermentAndApplyProfile(pi, runtime, undefined)
		return undefined
	}
	setActiveFermentAndApplyProfile(pi, runtime, existing)
	appendRefEntry(pi, existing.id)

	const wtCheck = checkWorktree(existing)
	if (wtCheck.severity !== "ok" && wtCheck.message) {
		void pi.sendMessage(
			{
				customType: "ferment_worktree_warning",
				content: [{ type: "text", text: wtCheck.message }],
				display: true,
				details: { text: wtCheck.message, variant: "warning" },
			},
			{ triggerTurn: false },
		)
	}
	return existing
}

/**
 * Shared by session_start (env-var path) and the /ferment Continue picker.
 * Flips paused to running, validates worktree, re-arms the scoping gate for
 * drafts, and schedules the next legal action so the planner picks up work.
 */
export function resumeFerment(
	pi: ExtensionAPI,
	fermentId: string,
	ctx: ExtensionContext,
	runtime: FermentRuntime = defaultFermentRuntime,
	opts: { allowManualPhaseBoundary?: boolean } = {},
): void {
	const storage = runtime.getStorage()
	const applyAndPersist = createApplyAndPersist(runtime)
	let existing = storage.get(fermentId)
	if (!existing) {
		setActiveFermentAndApplyProfile(pi, runtime, undefined)
		return
	}

	if (existing.status === "complete" || existing.status === "abandoned") {
		setActiveFermentAndApplyProfile(pi, runtime, undefined)
		return
	}

	// Session_shutdown sets running ferments to "paused"; flip back to running
	// on resume so the engine produces a real next-action nudge.
	if (existing.status === "paused") {
		const out = applyAndPersist(existing.id, { type: "resume" })
		if (out.ok) existing = out.ferment
	}

	setActiveFermentAndApplyProfile(pi, runtime, existing)
	appendRefEntry(pi, existing.id)

	const wtCheck = checkWorktree(existing)
	if (wtCheck.severity !== "ok" && wtCheck.message) {
		void pi.sendMessage(
			{
				customType: "ferment_worktree_warning",
				content: [{ type: "text", text: wtCheck.message }],
				display: true,
				details: { text: wtCheck.message, variant: "warning" },
			},
			{ triggerTurn: false },
		)
		if (wtCheck.severity === "block") {
			return
		}
	}

	if (existing.status === "draft" && ctx?.hasUI) {
		runtime.markScopingInteractive(existing.id)
	}

	const action = determineNextAction(existing)
	const baseMsg = action ? formatActionNudgeLine(action) : ""
	const scopeProgress = getScopingProgress(existing)
	const breadcrumb = `Resumed ferment: "${existing.name}" [${existing.status}] ${runtime.getContinuationPolicy()} policy · scoping ${scopeProgress.answered}/${scopeProgress.total}`

	const imperative =
		existing.status === "running"
			? `RESUMING ferment "${existing.name}" — the previous session was interrupted. Pick up the work immediately. Do NOT explain or summarize — execute the next action below.\n\n${baseMsg}`
			: baseMsg

	void pi.sendMessage(
		{
			customType: "ferment_breadcrumb",
			content: [{ type: "text", text: breadcrumb }],
			display: true,
			details: { text: breadcrumb, variant: "step" },
		},
		{ triggerTurn: false },
	)
	void pi.sendMessage(
		{
			customType: "ferment_resume_nudge",
			content: [{ type: "text", text: imperative }],
			display: false,
			details: undefined,
		},
		{ triggerTurn: true },
	)

	scheduleFermentWakeUp(pi, runtime, { ...opts, fermentId: existing.id, tag: "Resume wake-up" })
}
