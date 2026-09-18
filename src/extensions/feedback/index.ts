import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Key } from "@earendil-works/pi-tui"
import { MULTI_MODEL_ID } from "../../cli-args.js"
import { isSubagent } from "../prompt-construction/prompt-enrichment.js"
import { isAutoModel } from "../router/constants.js"
import { trackFeedback, trackModelSwitchFeedback } from "../telemetry/index.js"
import { type FeedbackSentiment, showFeedbackDetailsDialog } from "./dialog.js"
import { clearModelSwitchInvitation, getModelSwitchInvitation, setModelSwitchInvitation } from "./invitation-state.js"
import { showModelSwitchDialog } from "./model-switch-dialog.js"
import { type FeedbackSummaryDetails, feedbackSummaryRenderer } from "./renderer.js"

const FEEDBACK_SUMMARY_CUSTOM_TYPE = "feedback-summary"
const MODEL_SWITCH_SUMMARY_CUSTOM_TYPE = "model-switch-feedback"

type FeedbackState = "idle" | "inviting" | "collecting"

export default function feedbackExtension(pi: ExtensionAPI): void {
	// Subagents don't get a feedback prompt — they're already a feedback signal.
	if (isSubagent()) return

	pi.registerMessageRenderer(FEEDBACK_SUMMARY_CUSTOM_TYPE, feedbackSummaryRenderer)
	pi.registerMessageRenderer(MODEL_SWITCH_SUMMARY_CUSTOM_TYPE, feedbackSummaryRenderer)

	let state: FeedbackState = "idle"
	let autoModelUsed = false

	const reset = () => {
		state = "idle"
		autoModelUsed = false
		clearModelSwitchInvitation()
	}

	// Register global shortcuts so the rating and model-switch flows can be
	// triggered even when the main editor has focus. `pi.registerShortcut`
	// takes priority over editor input — unlike `ctx.ui.onTerminalInput`,
	// which the editor consumes first when focused.
	//
	// Three shortcuts are registered:
	//   - Ctrl+R  → model-switch feedback dialog (set on `model_select`
	//               from auto → concrete). Description reflects that flow
	//               only; the rating flow has its own keys.
	//   - Ctrl+1  → rate the last response as Good (positive sentiment).
	//   - Ctrl+2  → rate the last response as Bad (negative sentiment).
	// When a model-switch invitation is active it takes precedence over the
	// rating shortcuts in `handleShortcut`.
	pi.registerShortcut(Key.ctrl("r"), {
		description: "Tell us why you switched",
		handler: (ctx: ExtensionContext) => handleShortcut(ctx),
	})
	pi.registerShortcut(Key.ctrl("1"), {
		description: "Rate response as Good",
		handler: (ctx: ExtensionContext) => handleShortcut(ctx, "positive"),
	})
	pi.registerShortcut(Key.ctrl("2"), {
		description: "Rate response as Bad",
		handler: (ctx: ExtensionContext) => handleShortcut(ctx, "negative"),
	})

	pi.on("session_shutdown", () => {
		reset()
	})

	pi.on("turn_start", reset)
	pi.on("message_start", reset)

	pi.on("agent_end", (_event, ctx: ExtensionContext) => {
		state = "inviting"
		autoModelUsed = isAutoModel(ctx.model)
	})

	pi.on("model_select", (event, _ctx: ExtensionContext) => {
		// Only react in TUI mode — headless modes can't show a dialog.
		if (_ctx.mode !== "tui" || !_ctx.hasUI) return
		// Only react when the previous model was auto.
		if (!event.previousModel || !isAutoModel(event.previousModel)) return
		// Only react when the new model is a concrete model — skip auto/multi-model.
		const newModel = event.model
		if (!newModel) return
		if (isAutoModel(newModel)) return
		if (newModel.id === MULTI_MODEL_ID) return

		const modelId = newModel.id
		const modelName = newModel.name ?? newModel.id

		// Send the initial invitation message. We pass a fresh `details`
		// object inline (not stored anywhere mutable) so the renderer can
		// recognise it as a model-switch summary. We deliberately do NOT
		// keep a reference to mutate later — the message list is already
		// rendered, and a mutation would not trigger a re-render. When the
		// user submits a reason via Ctrl+R we send a brand-new message
		// instead (see handleShortcut).
		pi.sendMessage(
			{
				customType: MODEL_SWITCH_SUMMARY_CUSTOM_TYPE,
				content: [{ type: "text", text: `Tell us why you switched to ${modelName} (Ctrl+R)` }],
				display: true,
				details: { model: modelName, reason: "" },
			},
			{ triggerTurn: false },
		)

		// Don't pop the dialog immediately. Set an invitation so the prompt
		// summary knows a model-switch invitation is active. The user opens
		// the dialog explicitly with Ctrl+R.
		setModelSwitchInvitation({ modelName, modelId })
	})

	async function handleShortcut(ctx: ExtensionContext, sentiment?: FeedbackSentiment): Promise<void> {
		// Only fire in TUI mode. In headless modes (print/json/acp/rpc) there is
		// no keyboard to consume, so the shortcut is inert.
		if (ctx.mode !== "tui" || !ctx.hasUI) return

		// Model-switch invitation takes precedence over the rating flow.
		const activeInvitation = getModelSwitchInvitation()
		if (activeInvitation) {
			const { modelName, modelId } = activeInvitation
			// Clear the invitation immediately so a second Ctrl+R press while
			// the dialog is open doesn't stack a second dialog.
			clearModelSwitchInvitation()

			const result = await showModelSwitchDialog(ctx, { modelName })
			const reason = result?.reason.trim() ?? ""
			if (reason.length > 0) {
				// Send a NEW summary message carrying the reason details.
				// We don't mutate the existing invitation message because the
				// message list is already rendered — only a fresh message
				// causes the renderer to re-render with the reason.
				pi.sendMessage(
					{
						customType: MODEL_SWITCH_SUMMARY_CUSTOM_TYPE,
						content: [{ type: "text", text: `Reason: ${reason}` }],
						display: true,
						details: { model: modelName, reason },
					},
					{ triggerTurn: false },
				)
				trackModelSwitchFeedback({ reason, modelName, modelId })
			}
			// Esc or empty submit: leave the original invitation message as-is.
			return
		}

		// Rating shortcuts carry a sentiment; if none was passed we have nothing
		// to do (e.g. Ctrl+R without an active invitation).
		if (sentiment === undefined) return
		if (state !== "inviting") return
		state = "collecting"
		// Capture the auto-model flag for this invitation so the details dialog
		// sees the same value, even if `autoModelUsed` is reset by a concurrent
		// lifecycle event.
		const usedAutoModel = autoModelUsed
		let keepInviting = false
		try {
			// Yield once so the TUI removes the previous overlay (if any) before
			// the details dialog is mounted. Without this yield the dialog's
			// first frame can be composited with stale overlay content.
			await Promise.resolve()
			const submitted = await handleRating(pi, ctx, sentiment, usedAutoModel)
			// Esc from the details dialog: keep the invitation alive so the
			// user can rate the same turn again.
			if (!submitted) keepInviting = true
		} finally {
			if (keepInviting) {
				state = "inviting"
			} else if (state === "collecting") {
				state = "idle"
				autoModelUsed = false
			}
		}
	}
}

async function handleRating(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	sentiment: FeedbackSentiment,
	autoModelUsed: boolean,
): Promise<boolean> {
	let result: { reason: string } | undefined
	try {
		result = await showFeedbackDetailsDialog(ctx, { sentiment, autoModelUsed })
	} catch (err) {
		console.error("[feedback] Failed to collect details:", err)
		return false
	}
	// Esc cancels: no summary message and no telemetry. Caller keeps the
	// invitation alive so the user can try again.
	if (result === undefined) return false
	const reason = result.reason
	const payload: FeedbackSummaryDetails = { sentiment, reason }
	pi.sendMessage(
		{
			customType: FEEDBACK_SUMMARY_CUSTOM_TYPE,
			content: [{ type: "text", text: "<system-annotation>Feedback received</system-annotation>" }],
			display: true,
			details: payload,
		},
		{ triggerTurn: false },
	)
	trackFeedback({
		sentiment,
		reason,
		autoModelUsed,
	})
	return true
}
