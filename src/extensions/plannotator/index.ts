/**
 * Plannotator plan-review adapter.
 *
 * Translates between kimchi's internal plan-review bus
 * (`kimchi:plan-review-request` / `kimchi:plan-review-decision`) and
 * plannotator's extension event bus (`plannotator:request` /
 * `plannotator:review-result`).
 *
 * - On `kimchi:plan-review-request`: fires plannotator's browser UI by
 *   emitting `plannotator:request` with action `plan-review`.
 * - On `plannotator:review-result`: translates the approve/deny decision
 *   into a `kimchi:plan-review-decision` event.
 *
 * **Subscribe-side gating**: emitters always emit the request (even in
 * headless/oneshot sessions) so future integrations can hook in. This
 * adapter subscribes ONLY in interactive TUI sessions — opening a browser
 * in bench/CI would block on a human that isn't there.
 *
 * If plannotator isn't installed, the `plannotator:request` emit is a
 * no-op (nobody listens) and no browser opens. The TUI popup is the
 * fallback. Fire-and-forget — no timeout, no waiting.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import {
	emitPlanReviewDecision,
	getActivePlanReviewSource,
	onPlanReviewRequest,
	type PlanReviewRequestPayload,
} from "../../shared/planning/plan-review-bus.js"
import { PARENT_SESSION_ID_ENV_KEY } from "../agents/manager/constants.js"

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request"
const PLANNOTATOR_REVIEW_RESULT_CHANNEL = "plannotator:review-result"

export default function plannotatorExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		// Skip subagent sessions — they don't run plan reviews
		if (process.env[PARENT_SESSION_ID_ENV_KEY]) return

		// Subscribe-side gating: emitters always emit (even in headless/oneshot),
		// but this adapter only subscribes in interactive TUI sessions. Opening
		// plannotator's browser in bench/CI would block on a human that isn't
		// there. Future integrations (logging, alternative reviewers) can
		// subscribe independently.
		if (!ctx.hasUI || pi.getFlag("ferment-oneshot") === true) return

		// kimchi:plan-review-request → plannotator:request plan-review (browser UI)
		onPlanReviewRequest(pi, (payload: PlanReviewRequestPayload) => {
			const requestId = `kimchi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

			pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
				requestId,
				action: "plan-review",
				payload: {
					planContent: payload.planContent,
					planFilePath: payload.planFilePath,
					origin: payload.source,
				},
				respond: () => {
					// Fire-and-forget — we don't need the reviewId.
					// The decision arrives asynchronously via review-result.
				},
			})
		})

		// plannotator:review-result → kimchi:plan-review-decision
		pi.events.on(PLANNOTATOR_REVIEW_RESULT_CHANNEL, (data: unknown) => {
			const result = data as {
				approved?: boolean
				feedback?: string
			}
			if (typeof result?.approved !== "boolean") return

			// Determine which review surface this result belongs to
			const planReviewSource = getActivePlanReviewSource()
			if (!planReviewSource) return

			// Deny with a comment maps to "feedback" (model revises with direction).
			// Deny without one maps to "rework" — emitting "feedback" with empty
			// text would trigger a directionless revision turn.
			const feedback = result.feedback?.trim() || undefined
			emitPlanReviewDecision(pi, {
				decision: result.approved ? "execute" : feedback ? "feedback" : "rework",
				feedback,
				source: "plannotator",
				planReviewSource,
			})
		})
	})
}
