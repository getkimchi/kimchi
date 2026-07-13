import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { determineNextAction } from "../../ferment/engine.js"
import type { Ferment } from "../../ferment/types.js"
import { formatActionNudgeLine } from "./action-tool-names.js"
import { appendRefEntry } from "./nudge.js"
import { loadPendingProposal } from "./pending-proposal-store.js"
import { triggerPendingPlanReview } from "./plan-review-trigger.js"
import { type FermentRuntime, defaultFermentRuntime } from "./runtime.js"
import { safeSendMessage } from "./safe-send.js"
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
		safeSendMessage(
			pi,
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
		safeSendMessage(
			pi,
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

	// Hydrate a persisted pending proposal: if the previous session deferred
	// plan review (questions=[] path) and ended before the user reviewed it,
	// re-arm the plan review dialog instead of nudging the LLM to re-scope.
	if (existing.status === "draft") {
		const persisted = loadPendingProposal(existing.id)
		if (persisted) {
			runtime.setPendingScope(existing.id, {
				title: persisted.title,
				goal: persisted.goal,
				successCriteria: persisted.successCriteria,
				constraints: persisted.constraints,
				assumptions: persisted.assumptions,
				phases: persisted.phases,
				proposeIterations: persisted.proposeIterations,
			})
			runtime.setPendingPlanReview({
				fermentId: existing.id,
				planMarkdown: persisted.planMarkdown,
			})
			const breadcrumb = `Resumed ferment: "${existing.name}" [${existing.status}] · plan review re-armed from saved proposal`
			safeSendMessage(
				pi,
				{
					customType: "ferment_breadcrumb",
					content: [{ type: "text", text: breadcrumb }],
					display: true,
					details: { text: breadcrumb, variant: "step" },
				},
				{ triggerTurn: false },
			)
			// Re-arming the review in memory is not enough: the plan-review dialog
			// is rendered by `runPendingPlanReview`, which the `agent_end` handler
			// normally triggers via planReviewTimer. On a session restart no agent
			// turn fires naturally, so invoke the registered trigger directly —
			// this presents the saved proposal for review WITHOUT spinning up an
			// LLM turn (no scoping nudge, no re-propose risk).
			//
			// Early return is intentional: for a draft with a persisted proposal,
			// `determineNextAction` would return { kind: "scope" } (no phases yet)
			// which triggers a scoping nudge we explicitly want to suppress.
			// `scheduleFermentWakeUp` would schedule a wake-up that also nudges
			// the LLM — both are undesirable while a plan review is pending.
			triggerPendingPlanReview(ctx)
			return
		}
	}

	const action = determineNextAction(existing)
	const baseMsg = action ? formatActionNudgeLine(action) : ""
	const breadcrumb = `Resumed ferment: "${existing.name}" [${existing.status}] ${runtime.getContinuationPolicy()} policy`

	const imperative =
		existing.status === "running"
			? `RESUMING ferment "${existing.name}" — the previous session was interrupted. Pick up the work immediately. Do NOT explain or summarize — execute the next action below.\n\n${baseMsg}`
			: baseMsg

	safeSendMessage(
		pi,
		{
			customType: "ferment_breadcrumb",
			content: [{ type: "text", text: breadcrumb }],
			display: true,
			details: { text: breadcrumb, variant: "step" },
		},
		{ triggerTurn: false },
	)

	if (existing.status !== "paused") {
		safeSendMessage(
			pi,
			{
				customType: "ferment_resume_nudge",
				content: [{ type: "text", text: imperative }],
				display: false,
				details: undefined,
			},
			{ triggerTurn: true },
		)
	} else {
		safeSendMessage(
			pi,
			{
				customType: "ferment_paused_notice",
				content: [
					{
						type: "text",
						text: `Ferment "${existing.name}" is currently ${existing.status}. Ask the user to run /ferment resume to continue.`,
					},
				],
				display: true,
				details: undefined,
			},
			{ triggerTurn: false },
		)
		return
	}

	// `resumeFerment` already sent a `ferment_resume_nudge` with triggerTurn for
	// this ferment. Passing `skipNudge` prevents `scheduleFermentWakeUp` from
	// queuing a duplicate `ferment_continuation_nudge` for the same scope action
	// (only affects draft ferments where determineNextAction returns { kind: "scope" }).
	scheduleFermentWakeUp(pi, runtime, { ...opts, fermentId: existing.id, tag: "Resume wake-up", skipNudge: true })
}
