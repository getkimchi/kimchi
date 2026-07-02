/**
 * Decouples `resumeFerment` (resume.ts) from the `runPendingPlanReview`
 * closure defined inside `registerFermentExtension` (index.ts).
 *
 * Why: the plan-review dialog is rendered by `runPendingPlanReview`, which
 * the `agent_end` handler normally triggers via `planReviewTimer`. When a
 * draft ferment is resumed with a persisted pending proposal, no agent turn
 * fires naturally, so `agent_end` never runs and the re-armed review would
 * never be presented. Rather than spin up an LLM turn (which risks
 * re-proposing the scope), `resumeFerment` invokes the registered trigger
 * directly to present the saved proposal for review with no model turn.
 *
 * `index.ts` registers the trigger once during extension setup; `resume.ts`
 * calls `triggerPendingPlanReview(ctx)` after re-arming the in-memory review.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

type PlanReviewTrigger = (ctx: Pick<ExtensionContext, "ui"> | undefined) => void

let trigger: PlanReviewTrigger | undefined

export function setPendingPlanReviewTrigger(fn: PlanReviewTrigger | undefined): void {
	trigger = fn
}

/** Clear the registered trigger. Used by test teardown to prevent cross-suite leakage. */
export function clearPendingPlanReviewTrigger(): void {
	trigger = undefined
}

export function triggerPendingPlanReview(ctx: Pick<ExtensionContext, "ui"> | undefined): void {
	trigger?.(ctx)
}
