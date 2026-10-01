/**
 * Event-driven plan-review bus.
 *
 * Two channels on the pi event bus coordinate plan reviews across surfaces:
 *
 * - `kimchi:plan-review-request` — emitted when a plan is ready for review.
 *   Both the TUI popup and the plannotator adapter listen for this.
 *
 * - `kimchi:plan-review-decision` — emitted when any surface reaches a
 *   decision (TUI menu pick, plannotator browser approve/deny). First
 *   decision wins; subsequent emissions are silently ignored.
 *
 * Context (plan text, path, slug, etc.) is stored when the request is
 * emitted and consumed by the decision handler. Only one plan review is
 * active at a time — adhoc plan mode and ferment scoping are mutually
 * exclusive.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

export const PLAN_REVIEW_REQUEST_CHANNEL = "kimchi:plan-review-request"
export const PLAN_REVIEW_DECISION_CHANNEL = "kimchi:plan-review-decision"

export type PlanReviewSource = "adhoc" | "ferment"
export type PlanReviewDecision = "execute" | "start_ferment" | "start_cloud" | "rework" | "feedback"
export type PlanReviewDecisionSource = "kimchi-tui" | "plannotator"

export interface PlanReviewRequestPayload {
	readonly planContent: string
	readonly planFilePath?: string
	readonly source: PlanReviewSource
	readonly fermentId?: string
}

export interface PlanReviewDecisionPayload {
	readonly decision: PlanReviewDecision
	readonly feedback?: string
	readonly source: PlanReviewDecisionSource
	readonly planReviewSource: PlanReviewSource
	readonly fermentId?: string
	/** Ferment-only: user picked "start in auto mode" — run all stages without stopping. */
	readonly auto?: boolean
}

export interface PlanReviewContext {
	readonly ctx: ExtensionContext
	readonly planPath?: string
	readonly planText: string
	/** Raw assistant message text (before marker stripping) — used by ferment creation. */
	readonly rawText?: string
	readonly activePlanSlug?: string
	readonly fermentId?: string
}

// ── Internal state ────────────────────────────────────────────────────
//
// Module-level is acceptable: only one plan review can be active per
// session at a time. `currentContext` is set when a request is emitted
// and consumed when a decision is handled. `firstDecisionConsumed`
// ensures only the first decision acts — subsequent emissions (from a
// stale TUI menu pick arriving after plannotator already decided) are
// silently dropped.
let currentContext: PlanReviewContext | undefined
let firstDecisionConsumed = false
let currentSource: PlanReviewSource | undefined

/**
 * Emit a plan-review request and store the context for the decision handler.
 * Resets any previous pending review state.
 */
export function emitPlanReviewRequest(
	pi: ExtensionAPI,
	payload: PlanReviewRequestPayload,
	context: PlanReviewContext,
): void {
	currentContext = context
	currentSource = payload.source
	firstDecisionConsumed = false
	pi.events.emit(PLAN_REVIEW_REQUEST_CHANNEL, payload)
}

/**
 * Emit a plan-review decision. First decision wins — subsequent calls are
 * silently ignored. The decision is only emitted if a matching review is
 * active (same `planReviewSource`).
 */
export function emitPlanReviewDecision(pi: ExtensionAPI, payload: PlanReviewDecisionPayload): void {
	if (firstDecisionConsumed) return
	if (!currentContext) return
	if (payload.planReviewSource !== currentSource) return
	firstDecisionConsumed = true
	pi.events.emit(PLAN_REVIEW_DECISION_CHANNEL, payload)
}

/**
 * Consume the stored plan review context. Returns undefined if no review
 * is active or the context was already consumed. Clears state after
 * consumption.
 */
export function consumePlanReviewContext(): PlanReviewContext | undefined {
	const ctx = currentContext
	currentContext = undefined
	currentSource = undefined
	return ctx
}

/**
 * Check whether a plan review is currently active (request emitted,
 * decision not yet consumed). Used by the plannotator adapter to
 * determine which surface the review-result belongs to.
 */
export function getActivePlanReviewSource(): PlanReviewSource | undefined {
	return firstDecisionConsumed ? undefined : currentSource
}

/**
 * Register a handler for plan-review-request events.
 * Returns an unsubscribe function.
 */
export function onPlanReviewRequest(
	pi: ExtensionAPI,
	handler: (payload: PlanReviewRequestPayload) => void,
): () => void {
	return pi.events.on(PLAN_REVIEW_REQUEST_CHANNEL, (data: unknown) => {
		const payload = data as PlanReviewRequestPayload
		if (payload && typeof payload.planContent === "string") {
			handler(payload)
		}
	})
}

/**
 * Register a handler for plan-review-decision events.
 * Returns an unsubscribe function.
 */
export function onPlanReviewDecision(
	pi: ExtensionAPI,
	handler: (payload: PlanReviewDecisionPayload) => void,
): () => void {
	return pi.events.on(PLAN_REVIEW_DECISION_CHANNEL, (data: unknown) => {
		const payload = data as PlanReviewDecisionPayload
		if (payload && typeof payload.decision === "string") {
			handler(payload)
		}
	})
}
