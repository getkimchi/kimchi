import { _getTelemetryCtx, _isTelemetryEnabled } from "./index.js"

/**
 * Emit a structured `feedback.rating` telemetry event when the user submits a
 * post-turn thumbs up/down rating with a reason. Only structured fields are
 * emitted: the reason value is included and may be either a predefined label
 * or free-form text typed by the user.
 */
export function trackFeedback(args: {
	sentiment: "positive" | "negative"
	reason: string
	autoModelUsed: boolean
}): void {
	if (!_isTelemetryEnabled()) return
	const ctx = _getTelemetryCtx()
	if (!ctx) return
	ctx.emit("feedback.rating", {
		sentiment: args.sentiment,
		reason: args.reason,
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
