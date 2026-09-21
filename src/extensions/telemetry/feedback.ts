import { randomUUID } from "node:crypto"
import { _getTelemetryCtx, _isTelemetryEnabled } from "./index.js"
import { emitSurveyAnswered, type SurveyTelemetryDefinition } from "./survey.js"

// PostHog survey definitions (created in PostHog on 2026-09-21 — do NOT create
// new ones; the UUIDs are the wire contract with the kubecast posthog_mapping).

/** "Kimchi TUI Post-turn rating" — Q1 single_choice (Good/Bad) + optional open "Why?" (RATING_REASON_QUESTION_ID). */
const POST_TURN_RATING_SURVEY: SurveyTelemetryDefinition = {
	id: "01a0c519-1b63-0000-0806-99c16c6d6c18",
	version: 1,
	question: { id: "79c36d2a-4367-4340-b16f-8e9fb5386dca", text: "How was this turn?" },
	options: [
		{ id: "positive", label: "Good" },
		{ id: "negative", label: "Bad" },
	],
}
const RATING_REASON_QUESTION_ID = "be146fb0-9838-45f8-998b-8be74067234f"

/** "Kimchi TUI Auto Model Switch" — single open question. */
const MODEL_SWITCH_SURVEY: SurveyTelemetryDefinition = {
	id: "01a0c528-75ba-0000-1ec3-bc9506dd1698",
	version: 1,
	question: { id: "4dedb581-91f4-4d68-8cd5-e4a9f6eb726e", text: "Tell us why you switched" },
	options: [],
}

// Flow-context attribute names — the wire contract with kubecast's
// posthog_mapping.go ("survey sent" mapping). Missing values must be omitted
// from extraAttrs, never sent as empty strings.
//
// Correlation to the rated run uses the standard request trace attrs
// ("request.trace_id" / "request.span_id", same as api_request/error events)
// stamped from the most recent provider request. Upstream's turn_index counts
// LLM round-trips per agent run and resets on every prompt, so it cannot
// identify the rated prompt — it is deliberately not sent here.
const autoModelUsedAttr = "auto_model_used"
const reasonTypeAttr = "reason_type"
const modelIDAttr = "model_id"
const reasonTruncatedAttr = "reason_truncated"

/**
 * Cap on free-form reason text, matching the `.slice(0, 300)` convention used
 * for every other user-controlled string this pipeline emits (error messages,
 * transport errors, tool output).
 *
 * The reason field accepts bracketed paste, so without a cap a single
 * submission can carry an unbounded payload — an accidental paste of a log or
 * a whole file, or a deliberate attempt to inflate the telemetry pipeline.
 * 300 characters is far more than a usable sentence of feedback and keeps one
 * event within a sane size.
 */
export const MAX_REASON_LENGTH = 300

/**
 * Clamp a user-supplied reason to `MAX_REASON_LENGTH`, reporting whether it was
 * cut so a truncated sample is never read as the user's whole answer.
 */
export function clampReason(reason: string): { value: string; truncated: boolean } {
	if (reason.length <= MAX_REASON_LENGTH) return { value: reason, truncated: false }
	return { value: reason.slice(0, MAX_REASON_LENGTH), truncated: true }
}

/**
 * Emit a `survey_answered` event for the post-turn thumbs up/down rating.
 *
 * Each submission maps to one PostHog "survey sent" event carrying the
 * sentiment as `$survey_response_<Q1>` ("Good"/"Bad") and the optional
 * free-form reason as `$survey_response_<Q2>`. The reason text is sent
 * verbatim so the team can act on what users actually report; `reason_type`
 * marks which reasons are free-form (may contain file paths, hostnames or
 * pasted code) so downstream pipelines can treat them differently.
 */
export function trackFeedback(args: {
	sentiment: "positive" | "negative"
	reason: string
	reasonType: "predefined" | "freeform"
	autoModelUsed: boolean
}): void {
	if (!_isTelemetryEnabled()) return
	const ctx = _getTelemetryCtx()
	if (!ctx) return
	const reason = clampReason(args.reason)
	emitSurveyAnswered(ctx, {
		survey: POST_TURN_RATING_SURVEY,
		submissionId: randomUUID(),
		answerId: args.sentiment,
		...(reason.value.length > 0 && {
			secondResponse: { questionId: RATING_REASON_QUESTION_ID, answerValue: reason.value },
		}),
		extraAttrs: {
			...ctx.getTraceAttributes(),
			[autoModelUsedAttr]: args.autoModelUsed,
			[reasonTypeAttr]: args.reasonType,
			...(reason.truncated && { [reasonTruncatedAttr]: true }),
		},
	})
}

/**
 * Emit a `survey_answered` event when the user switches from auto-model to a
 * concrete model and provides a reason (free-form, sent verbatim).
 *
 * `modelName` stays in the signature for the existing call site but is
 * intentionally not emitted — whether to attach `model_name` in addition to
 * `model_id` is an open product question.
 */
export function trackModelSwitchFeedback(args: { reason: string; modelName: string; modelId: string }): void {
	if (!_isTelemetryEnabled()) return
	const ctx = _getTelemetryCtx()
	if (!ctx) return
	const reason = clampReason(args.reason)
	emitSurveyAnswered(ctx, {
		survey: MODEL_SWITCH_SURVEY,
		submissionId: randomUUID(),
		answerValue: reason.value,
		extraAttrs: {
			...ctx.getTraceAttributes(),
			[modelIDAttr]: args.modelId,
			...(reason.truncated && { [reasonTruncatedAttr]: true }),
		},
	})
}
