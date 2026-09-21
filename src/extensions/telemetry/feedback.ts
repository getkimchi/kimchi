import { _getTelemetryCtx, _isTelemetryEnabled } from "./index.js"

/**
 * Emit a structured `feedback.rating` telemetry event when the user submits a
 * post-turn thumbs up/down rating with a reason.
 *
 * The `reason` value is emitted verbatim so the team can act on what users
 * actually report. For a "Type your own answer" submission that is arbitrary
 * free-form text and may contain file paths, hostnames or pasted code, so
 * `reason_type` marks which reasons are free-form and lets downstream
 * pipelines treat them differently from the predefined labels.
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
	ctx.emit("feedback.rating", {
		sentiment: args.sentiment,
		reason: args.reason,
		reason_type: args.reasonType,
		auto_model_used: args.autoModelUsed,
	})
}

/**
 * Emit a structured `feedback.model_switch` telemetry event when the user
 * switches from auto-model to a concrete model and provides a reason.
 */
export function trackModelSwitchFeedback(args: { reason: string; modelName: string; modelId: string }): void {
	if (!_isTelemetryEnabled()) return
	const ctx = _getTelemetryCtx()
	if (!ctx) return
	ctx.emit("feedback.model_switch", {
		reason: args.reason,
		model_name: args.modelName,
		model_id: args.modelId,
	})
}
