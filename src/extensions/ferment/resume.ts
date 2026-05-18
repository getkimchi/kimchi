import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { determineNextAction, getScopingProgress } from "../../ferment/engine.js"
import { formatActionNudgeLine } from "./action-tool-names.js"
import { appendRefEntry } from "./nudge.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { createApplyAndPersist } from "./tool-helpers.js"
import { setActiveFermentAndApplyProfile } from "./tool-scope.js"
import { checkWorktree } from "./worktree.js"

export function sendLifecycleResumeNudge(
	pi: ExtensionAPI,
	existing: NonNullable<ReturnType<FermentRuntime["getActive"]>>,
	runtime: FermentRuntime = defaultFermentRuntime,
	opts: { allowManualPhaseBoundary?: boolean } = {},
): void {
	const action = determineNextAction(existing)
	if (!runtime.isAutoModeEnabled() && action.kind === "activate_phase" && !opts.allowManualPhaseBoundary) {
		pi.appendEntry("ferment_breadcrumb", {
			text: `Manual resume waiting at phase boundary for "${existing.name}".`,
		})
		return
	}

	const baseMsg = formatActionNudgeLine(action)
	const scopeProgress = getScopingProgress(existing)
	const breadcrumb = `Resumed ferment: "${existing.name}" [${existing.status}] policy ${runtime.getContinuationPolicy()} · scoping ${scopeProgress.answered}/${scopeProgress.total}`

	const imperative =
		existing.status === "running"
			? `RESUMING ferment "${existing.name}" — the previous session was interrupted. Pick up the work immediately. Do NOT explain or summarize — execute the next action below.\n\n${baseMsg}`
			: baseMsg

	pi.appendEntry("ferment_breadcrumb", { text: breadcrumb })
	void pi.sendMessage(
		{
			customType: "ferment_resume_nudge",
			content: [{ type: "text", text: imperative }],
			display: false,
			details: undefined,
		},
		{ triggerTurn: true },
	)
}

/**
 * Shared by session_start (env-var path) and the /ferment Continue picker.
 * Flips paused to running, validates worktree, re-arms the scoping gate for
 * drafts, and fires an imperative resume nudge so the planner picks up work.
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
		pi.appendEntry("ferment_worktree_warning", { text: wtCheck.message })
		if (wtCheck.severity === "block") {
			return
		}
	}

	if (existing.status === "draft" && ctx?.hasUI) {
		runtime.markScopingInteractive(existing.id)
	}

	sendLifecycleResumeNudge(pi, existing, runtime, opts)
}
