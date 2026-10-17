/**
 * Shared rating-recording seam for both feedback surfaces (TUI dialog flow
 * and the ACP `_kimchi.dev/feedback` ext-method). Records what a rating
 * submission means in Kimchi:
 *
 * - a `feedback-summary` custom transcript ENTRY (never a message — feedback
 *   must not enter the model's context), and
 * - a `trackFeedback` telemetry call whose `reasonType` stays honest
 *   ("predefined" vs "freeform" is used downstream to filter typed text)
 *   and whose `routingModelId` reports the routed pick captured at settle
 *   time, never client-supplied.
 *
 * `appendEntry` is injected because each surface owns a different writer:
 * the TUI passes `pi.appendEntry`; the ACP server passes
 * `session.sessionManager.appendCustomEntry`.
 */

import { trackFeedback } from "../telemetry/index.js"
import { clampReason, type FeedbackSentiment, isPredefinedReason } from "./dialog.js"
import type { RatingWindow } from "./rating-window.js"
import type { FeedbackSummaryDetails } from "./renderer.js"

/** Custom entry type the feedback extension registers a renderer for. */
export const FEEDBACK_SUMMARY_CUSTOM_TYPE = "feedback-summary"

export type RecordRatingOptions = {
	/** Surface-provided transcript-entry writer. */
	appendEntry: (customType: string, details: FeedbackSummaryDetails) => void
	sentiment: FeedbackSentiment
	/** A predefined label or typed custom text; clamped to the shared 300-char cap. */
	reason: string
	/** The settled turn's window state the rating attaches to. */
	window: RatingWindow
}

export type RecordRatingResult = { status: "recorded" }

export function recordRating(opts: RecordRatingOptions): RecordRatingResult {
	const reason = clampReason(opts.reason)
	const { window } = opts
	opts.appendEntry(FEEDBACK_SUMMARY_CUSTOM_TYPE, { sentiment: opts.sentiment, reason })
	trackFeedback({
		sentiment: opts.sentiment,
		reason,
		reasonType: isPredefinedReason(reason) ? "predefined" : "freeform",
		routingModelId: window.autoModelUsed ? window.routedModelId : undefined,
	})
	return { status: "recorded" }
}
