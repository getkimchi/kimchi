import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Key, matchesKey } from "@earendil-works/pi-tui"
import { MULTI_MODEL_ID } from "../../cli-args.js"
import { isSubagent } from "../prompt-construction/prompt-enrichment.js"
import { isAutoModel } from "../router/constants.js"
import { trackFeedback, trackModelSwitchFeedback } from "../telemetry/index.js"
import { type FeedbackSentiment, isPredefinedReason, showFeedbackDetailsDialog } from "./dialog.js"
import { clearModelSwitchInvitation, getModelSwitchInvitation, setModelSwitchInvitation } from "./invitation-state.js"
import { showModelSwitchDialog } from "./model-switch-dialog.js"
import { type FeedbackSummaryDetails, feedbackSummaryRenderer } from "./renderer.js"

const FEEDBACK_SUMMARY_CUSTOM_TYPE = "feedback-summary"
const MODEL_SWITCH_SUMMARY_CUSTOM_TYPE = "model-switch-feedback"

type FeedbackState = "idle" | "inviting" | "collecting"

export default function feedbackExtension(pi: ExtensionAPI): void {
	// Subagents don't get a feedback prompt — they're already a feedback signal.
	if (isSubagent()) return

	// Feedback is rendered from custom *entries*, not custom messages. Entries do
	// not participate in LLM context, which matters here because the reason field
	// carries free-form user text: routing it through `pi.sendMessage()` would
	// feed it back to the model on the next turn.
	pi.registerEntryRenderer(FEEDBACK_SUMMARY_CUSTOM_TYPE, feedbackSummaryRenderer)
	pi.registerEntryRenderer(MODEL_SWITCH_SUMMARY_CUSTOM_TYPE, feedbackSummaryRenderer)

	let state: FeedbackState = "idle"
	let autoModelUsed = false

	const reset = () => {
		state = "idle"
		autoModelUsed = false
		clearModelSwitchInvitation()
		stopListeningForCtrlR()
	}

	// Rating shortcuts are registered statically: they are always available once
	// a turn settles, and neither key is a built-in binding.
	//   - Ctrl+1 → rate the last response as Good (positive sentiment).
	//   - Ctrl+2 → rate the last response as Bad (negative sentiment).
	pi.registerShortcut(Key.ctrl("1"), {
		description: "Rate response as Good",
		handler: (ctx: ExtensionContext) => handleShortcut(ctx, "positive"),
	})
	pi.registerShortcut(Key.ctrl("2"), {
		description: "Rate response as Bad",
		handler: (ctx: ExtensionContext) => handleShortcut(ctx, "negative"),
	})

	// Ctrl+R is NOT registered statically. `app.session.rename` is a built-in on
	// the same key, and `getShortcuts()` builds its table once at startup — so a
	// static registration emits an "Extension shortcut conflict" diagnostic for
	// the whole session even though the handler only does anything while a
	// model-switch invitation is up. Subscribing to raw input for the lifetime
	// of the invitation keeps the key unclaimed the rest of the time, which
	// leaves the built-in rename (reachable from the /resume selector) alone.
	let unsubscribeCtrlR: (() => void) | undefined
	const stopListeningForCtrlR = () => {
		unsubscribeCtrlR?.()
		unsubscribeCtrlR = undefined
	}
	const listenForCtrlR = (ctx: ExtensionContext) => {
		stopListeningForCtrlR()
		unsubscribeCtrlR = ctx.ui.onTerminalInput((data: string) => {
			// Returning undefined passes the key through untouched.
			if (!matchesKey(data, Key.ctrl("r"))) return undefined
			// Nothing awaits this handler, so a rejection would otherwise be
			// unhandled — surface it in the UI instead of crashing the process.
			void handleShortcut(ctx).catch((err: unknown) => {
				ctx.ui.notify(`[feedback] Feedback shortcut failed: ${err}`, "error")
			})
			return { consume: true }
		})
	}

	// Session replacement (/resume, /fork, /clone) fires session_shutdown then
	// session_start. Reset on both so a stale invitation from the previous
	// session can never leak into the new one.
	pi.on("session_shutdown", reset)
	pi.on("session_start", reset)

	pi.on("turn_start", reset)

	// `agent_settled`, not `agent_end`: after `agent_end` Pi may still auto-retry,
	// auto-compact and retry, or run queued follow-up messages, so rating there
	// can prompt on a response that is about to be superseded.
	pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
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

		// Append the initial invitation entry. We pass a fresh data object
		// inline (not stored anywhere mutable) so the renderer can recognise
		// it as a model-switch summary. We deliberately do NOT keep a
		// reference to mutate later — the transcript is already rendered, and
		// a mutation would not trigger a re-render. When the user submits a
		// reason via Ctrl+R we append a brand-new entry instead (see
		// handleShortcut).
		pi.appendEntry(MODEL_SWITCH_SUMMARY_CUSTOM_TYPE, { model: modelName, reason: "" })

		// Don't pop the dialog immediately. Set an invitation so the prompt
		// summary knows a model-switch invitation is active. The user opens
		// the dialog explicitly with Ctrl+R.
		setModelSwitchInvitation({ modelName, modelId })
		listenForCtrlR(_ctx)
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
			stopListeningForCtrlR()

			let result: { reason: string } | undefined
			try {
				result = await showModelSwitchDialog(ctx, { modelName })
			} catch (err) {
				// Restore the invitation so the user can retry with Ctrl+R —
				// we cleared it above to guard against stacked dialogs.
				setModelSwitchInvitation({ modelName, modelId })
				listenForCtrlR(ctx)
				ctx.ui.notify(`[feedback] Failed to collect model-switch reason: ${err}`, "error")
				return
			}
			// Esc (undefined) leaves the rendered `... (Ctrl+R)` invitation on
			// screen, so the key has to keep working or the transcript shows a
			// call-to-action that does nothing. This mirrors the rating flow,
			// which keeps its invitation alive on Esc via `keepInviting`.
			//
			// An empty submit is a deliberate "no reason": the user answered,
			// so the invitation is consumed and Ctrl+R goes quiet.
			if (result === undefined) {
				setModelSwitchInvitation({ modelName, modelId })
				listenForCtrlR(ctx)
				return
			}

			const reason = result.reason.trim()
			if (reason.length > 0) {
				// Append a NEW summary entry carrying the reason. We don't
				// mutate the existing invitation entry because the transcript
				// is already rendered — only a fresh entry causes the renderer
				// to re-render with the reason.
				//
				// Guarded because this runs from the raw `onTerminalInput`
				// handler via `void handleShortcut(...)`: an unguarded throw
				// there surfaces as an unhandled rejection rather than a
				// notification, and the invitation is already cleared.
				try {
					pi.appendEntry(MODEL_SWITCH_SUMMARY_CUSTOM_TYPE, { model: modelName, reason })
					trackModelSwitchFeedback({ reason, modelName, modelId })
				} catch (err) {
					setModelSwitchInvitation({ modelName, modelId })
					listenForCtrlR(ctx)
					ctx.ui.notify(`[feedback] Failed to record model-switch reason: ${err}`, "error")
				}
			}
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
			// Only resurrect the invitation if no lifecycle event reset us while
			// the dialog was open — otherwise we'd re-arm the rating shortcuts
			// for a turn that has already moved on.
			if (keepInviting && state === "collecting") {
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
		// `console.error` would corrupt the TUI frame — route through the UI.
		ctx.ui.notify(`[feedback] Failed to collect details: ${err}`, "error")
		return false
	}
	// Esc cancels: no summary entry and no telemetry. Caller keeps the
	// invitation alive so the user can try again.
	if (result === undefined) return false
	const reason = result.reason
	const payload: FeedbackSummaryDetails = { sentiment, reason }
	// Guarded for the same reason as the model-switch branch: report the
	// failure instead of rejecting, and report the rating as un-submitted so
	// the caller keeps the invitation alive for a retry.
	try {
		pi.appendEntry(FEEDBACK_SUMMARY_CUSTOM_TYPE, payload)
		trackFeedback({
			sentiment,
			reason,
			reasonType: isPredefinedReason(reason) ? "predefined" : "freeform",
			autoModelUsed,
		})
	} catch (err) {
		ctx.ui.notify(`[feedback] Failed to record rating: ${err}`, "error")
		return false
	}
	return true
}
