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
const turnIndexAttr = "turn_index"
const autoModelUsedAttr = "auto_model_used"
const reasonTypeAttr = "reason_type"
const modelIDAttr = "model_id"

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
	emitSurveyAnswered(ctx, {
		survey: POST_TURN_RATING_SURVEY,
		submissionId: randomUUID(),
		answerId: args.sentiment,
		...(args.reason.length > 0 && {
			secondResponse: { questionId: RATING_REASON_QUESTION_ID, answerValue: args.reason },
		}),
		extraAttrs: {
			[turnIndexAttr]: ctx.turnIndex,
			[autoModelUsedAttr]: args.autoModelUsed,
			[reasonTypeAttr]: args.reasonType,
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
	emitSurveyAnswered(ctx, {
		survey: MODEL_SWITCH_SURVEY,
		submissionId: randomUUID(),
		answerValue: args.reason,
		extraAttrs: {
			[turnIndexAttr]: ctx.turnIndex,
			[modelIDAttr]: args.modelId,
		},
	})
}
