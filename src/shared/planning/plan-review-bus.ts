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
 * Context (plan text, path, slug, etc.) is stored by session when the request
 * is emitted and consumed by that session's decision handler.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

export const PLAN_REVIEW_REQUEST_CHANNEL = "kimchi:plan-review-request"
export const PLAN_REVIEW_DECISION_CHANNEL = "kimchi:plan-review-decision"
export const PLAN_REVIEW_RESOLVED_CHANNEL = "kimchi:plan-review-resolved"
export const PLAN_REVIEW_RESOLVED_CUSTOM_TYPE = "kimchi.plan_review_resolved"

export type PlanReviewSource = "adhoc" | "ferment"
export type PlanReviewDecision = "execute" | "start_ferment" | "start_cloud" | "rework" | "feedback"
export type PlanReviewDecisionSource = "kimchi-tui" | "plannotator"

export interface PlanReviewRequestPayload {
	readonly sessionId: string
	readonly planContent: string
	readonly planFilePath?: string
	readonly source: PlanReviewSource
	readonly fermentId?: string
}

export interface PlanReviewDecisionPayload {
	readonly sessionId: string
	readonly decision: PlanReviewDecision
	readonly feedback?: string
	readonly source: PlanReviewDecisionSource
	readonly planReviewSource: PlanReviewSource
	readonly fermentId?: string
	/** Ferment-only: user picked "start in auto mode" — run all stages without stopping. */
	readonly auto?: boolean
}

export type PlanReviewResolvedOutcome = "accepted" | "feedback" | "rework" | "replaced_by_ferment"

export interface PlanReviewResolvedPayload {
	readonly sessionId: string
	readonly decision: PlanReviewDecision
	readonly planReviewSource: PlanReviewSource
	readonly outcome: PlanReviewResolvedOutcome
	readonly fermentId?: string
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

interface PlanReviewState {
	context: PlanReviewContext
	firstDecisionConsumed: boolean
	source: PlanReviewSource
}

const reviewsBySession = new Map<string, PlanReviewState>()

/**
 * Emit a plan-review request and store the context for the decision handler.
 * Resets any previous pending review state.
 */
export function emitPlanReviewRequest(
	pi: ExtensionAPI,
	payload: PlanReviewRequestPayload,
	context: PlanReviewContext,
): void {
	reviewsBySession.set(payload.sessionId, {
		context,
		firstDecisionConsumed: false,
		source: payload.source,
	})
	pi.events.emit(PLAN_REVIEW_REQUEST_CHANNEL, payload)
}

/**
 * Emit a plan-review decision. First decision wins — subsequent calls are
 * silently ignored. The decision is only emitted if a matching review is
 * active (same `planReviewSource`).
 */
export function emitPlanReviewDecision(pi: ExtensionAPI, payload: PlanReviewDecisionPayload): void {
	const review = reviewsBySession.get(payload.sessionId)
	if (!review) return
	if (review.firstDecisionConsumed) return
	if (payload.planReviewSource !== review.source) return
	review.firstDecisionConsumed = true
	pi.events.emit(PLAN_REVIEW_DECISION_CHANNEL, payload)
}

/**
 * Emit the post-handler resolution signal. This is intentionally separate
 * from the decision signal, which only means the user selected an option.
 */
export function emitPlanReviewResolved(pi: ExtensionAPI, payload: PlanReviewResolvedPayload): void {
	pi.events.emit(PLAN_REVIEW_RESOLVED_CHANNEL, payload)
}

export function appendPlanReviewResolvedEntry(ctx: ExtensionContext, payload: PlanReviewResolvedPayload): void {
	const sessionManager = ctx.sessionManager as unknown as {
		appendCustomEntry?: (customType: string, data?: unknown) => unknown
	}
	sessionManager.appendCustomEntry?.(PLAN_REVIEW_RESOLVED_CUSTOM_TYPE, {
		sessionId: payload.sessionId,
		source: payload.planReviewSource,
		decision: payload.decision,
		outcome: payload.outcome,
		fermentId: payload.fermentId,
	})
}

/**
 * Consume the stored plan review context for one session. Returns undefined if
 * no review is active or the context was already consumed. Clears state after
 * consumption.
 */
export function consumePlanReviewContext(sessionId: string): PlanReviewContext | undefined {
	const review = reviewsBySession.get(sessionId)
	if (!review) return undefined
	reviewsBySession.delete(sessionId)
	return review.context
}

/**
 * Check whether a plan review is currently active (request emitted,
 * decision not yet consumed). Used by the plannotator adapter to
 * determine which surface the review-result belongs to.
 */
export function getActivePlanReviewSource(sessionId: string): PlanReviewSource | undefined {
	const review = reviewsBySession.get(sessionId)
	if (!review || review.firstDecisionConsumed) return undefined
	return review.source
}

export function clearPlanReviewState(sessionId?: string): void {
	if (sessionId) {
		reviewsBySession.delete(sessionId)
		return
	}
	reviewsBySession.clear()
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
		if (payload && typeof payload.sessionId === "string" && typeof payload.planContent === "string") {
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
		if (payload && typeof payload.sessionId === "string" && typeof payload.decision === "string") {
			handler(payload)
		}
	})
}

export function onPlanReviewResolved(
	pi: ExtensionAPI,
	handler: (payload: PlanReviewResolvedPayload) => void,
): () => void {
	return pi.events.on(PLAN_REVIEW_RESOLVED_CHANNEL, (data: unknown) => {
		const payload = data as PlanReviewResolvedPayload
		if (payload && typeof payload.sessionId === "string" && typeof payload.decision === "string") {
			handler(payload)
		}
	})
}
