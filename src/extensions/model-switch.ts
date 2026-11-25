import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { availableModelRefs, findModelByRef, refFromModel, splitModelRef } from "../shared/model-ref.js"
import { resolveEffectiveModel } from "./auto-model/state.js"
import { startNewInteractiveSessionWithModel } from "./interactive-model-session.js"
import {
	contextFitsModel,
	getSafeContextWindow,
	refreshLatestMessagesFromSession,
	resolveContextTokens,
	sessionHasImages,
} from "./model-guard.js"
import { MODEL_CAPABILITIES } from "./orchestration/model-registry/builtin-models.js"
import type { ModelTier } from "./orchestration/model-registry/types.js"
import { shouldSuppressInteractiveTools } from "./print-mode.js"
import { formatStrippedImagesOutcome, notifyStripSessionImagesResult, stripSessionImages } from "./strip-images.js"

/** Prevents model_select handler from re-checking what set_model tool already validated. */
let suppressModelSelectGuard = false

/** Suppress the model_select guard temporarily while a caller sets an already-validated model. */
export async function withSuppressedModelSelectGuard<T>(fn: () => Promise<T>): Promise<T> {
	suppressModelSelectGuard = true
	return fn().finally(() => {
		suppressModelSelectGuard = false
	})
}

/** Recursion guard — true while our own revert is in progress. */
let isRevertingModel = false

/** Resets module state between tests. */
export function __resetModelSwitchStateForTest(): void {
	suppressModelSelectGuard = false
	isRevertingModel = false
}

/**
 * Extract tier from a model descriptor via MODEL_CAPABILITIES.
 * In tests, pass the capabilities map explicitly to avoid module-isolation issues.
 */
export function getModelTier(
	model: Model<Api> | undefined,
	capsMap: ReadonlyMap<string, unknown> = MODEL_CAPABILITIES,
): ModelTier | undefined {
	if (!model) return undefined
	const caps = capsMap.get(model.id)
	if (!caps || caps === "ignored") return undefined
	return (caps as { tier: ModelTier }).tier
}

type StartNewSessionWithModel = (
	sessionManager: ExtensionContext["sessionManager"],
	model: Model<Api>,
) => Promise<boolean>

export default function modelSwitchExtension(
	pi: ExtensionAPI,
	startNewSessionWithModel: StartNewSessionWithModel = startNewInteractiveSessionWithModel,
) {
	// Model switching is an interactive action: in --print runs the model is
	// pinned by the CLI and set_model is dead schema weight.
	if (!shouldSuppressInteractiveTools()) {
		pi.registerTool({
			name: "set_model",
			label: "Switch Model",
			description:
				'Change the active AI model to a different one. Provide the model in provider/id format, e.g. "kimchi-dev/kimi-k2.6". Uses pi.setModel() internally. Use list_models to get the available models.',
			parameters: Type.Object({
				model: Type.String({
					description:
						'Target model identifier in "provider/modelId" format (e.g. "kimchi-dev/kimi-k2.6", "anthropic/claude-sonnet-4-20250514").',
				}),
			}),
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const sessionId = ctx.sessionManager.getSessionId()
				const { model } = params

				if (!splitModelRef(model)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Invalid model format: "${model}". Expected "provider/modelId".\n\nAvailable models:\n${availableModelRefs(ctx.modelRegistry).join("\n")}`,
							},
						],
						details: null,
					}
				}

				const target = findModelByRef(ctx.modelRegistry, model)
				if (!target) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Model not found: ${model}\n\nAvailable models:\n${availableModelRefs(ctx.modelRegistry).join("\n")}`,
							},
						],
						details: null,
					}
				}

				// When switching TO Auto, resolve the effective (routed) concrete model so
				// the guards validate against the real window/modalities, not Auto's
				// conservative catalog floor. Keep pi.setModel(target) so Auto stays selected.
				const effectiveTarget = resolveEffectiveModel(target, sessionId) ?? target

				const usage = ctx.getContextUsage()
				const refreshed = await refreshLatestMessagesFromSession(ctx)
				if (refreshed.status !== "ok") {
					return {
						content: [
							{
								type: "text" as const,
								text: "Could not load the latest session context. Retry the model switch after the current session update finishes.",
							},
						],
						details: null,
					}
				}
				const tokens = resolveContextTokens(usage, refreshed.messages)
				if (tokens != null && !contextFitsModel(tokens, effectiveTarget.contextWindow)) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Current context (${tokens} tokens) exceeds the target model "${model}" safe context limit (${getSafeContextWindow(effectiveTarget.contextWindow)} of ${effectiveTarget.contextWindow} tokens). Switch rejected to prevent data loss. Use /compact to reduce context size, then retry.`,
							},
						],
						details: null,
					}
				}

				// Vision compatibility guard
				if (!effectiveTarget.input.includes("image") && ctx.model?.input.includes("image")) {
					if (sessionHasImages()) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Current conversation contains images but target model "${model}" does not support vision input. Run /strip-images to replace images with text descriptions, then retry.`,
								},
							],
							details: null,
						}
					}
				}

				let ok: boolean
				suppressModelSelectGuard = true
				try {
					ok = await pi.setModel(target, { persist: true })
				} finally {
					suppressModelSelectGuard = false
				}
				if (!ok) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Failed to switch to ${refFromModel(target)} — no API key available for this model's provider.`,
							},
						],
						details: null,
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: `Switched to model ${refFromModel(target)} (${target.name})`,
						},
					],
					details: null,
				}
			},
		})
	}

	pi.on("model_select", async (event, ctx) => {
		if (isRevertingModel || suppressModelSelectGuard || event.source === "restore" || !event.previousModel) return

		const previousModel = event.previousModel
		const sessionId = ctx.sessionManager.getSessionId()
		const effectiveTarget = resolveEffectiveModel(event.model, sessionId) ?? event.model
		const refreshed = await refreshLatestMessagesFromSession(ctx)
		let reverted = false

		const revertToPrevious = async (): Promise<boolean> => {
			if (reverted) return true
			isRevertingModel = true
			try {
				reverted = await pi.setModel(previousModel)
				if (!reverted) {
					ctx.ui.notify(
						`Could not restore ${refFromModel(previousModel)}. ${refFromModel(event.model)} remains active; check the model configuration and retry.`,
						"error",
					)
				}
				return reverted
			} finally {
				isRevertingModel = false
			}
		}

		if (refreshed.status !== "ok") {
			if (await revertToPrevious()) {
				ctx.ui.notify("Could not load the latest session context; the previous model remains active.", "error")
			}
			return
		}

		const needsImageStrip = () =>
			sessionHasImages() && !effectiveTarget.input.includes("image") && previousModel.input.includes("image")

		const switchToValidatedTarget = async (): Promise<boolean> => {
			const ok = await withSuppressedModelSelectGuard(() => pi.setModel(event.model))
			if (!ok) ctx.ui.notify("Could not activate the requested model; the previous model remains active.", "error")
			return ok
		}

		const offerStripAndSwitch = async (): Promise<void> => {
			if (!(await revertToPrevious())) return
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`Session contains images but ${event.model.id} does not support vision. Run /strip-images to unlock non-vision models, or use a vision-capable model.`,
					"error",
				)
				return
			}

			const stripAndSwitch = "Strip images and switch"
			const choice = await ctx.ui.select(`Session contains images but ${event.model.id} does not support vision`, [
				stripAndSwitch,
			])
			if (choice !== stripAndSwitch) {
				ctx.ui.notify("Model switch cancelled; the previous model remains active.", "info")
				return
			}

			const result = await stripSessionImages(ctx)
			if (result.status !== "stripped") {
				notifyStripSessionImagesResult(ctx, result)
				ctx.ui.notify("Model switch cancelled; the previous model remains active.", "info")
				return
			}
			if (!(await switchToValidatedTarget())) return
			ctx.ui.notify(
				`${formatStrippedImagesOutcome(result)} and switched to ${refFromModel(event.model)}.`,
				result.processedCount === 0 ? "warning" : "info",
			)
		}

		const usage = ctx.getContextUsage?.()
		const tokens = resolveContextTokens(usage, refreshed.messages)
		if (tokens != null && !contextFitsModel(tokens, effectiveTarget.contextWindow)) {
			if (!(await revertToPrevious())) return
			const limit = getSafeContextWindow(effectiveTarget.contextWindow)
			const excess = tokens - limit
			if (!ctx.hasUI) {
				ctx.ui.notify(
					`Current context (${tokens.toLocaleString()} tokens) exceeds the ${event.model.id} safe context limit (${limit.toLocaleString()} of ${effectiveTarget.contextWindow.toLocaleString()} tokens) by ${excess.toLocaleString()} tokens. Start a new session or compact before switching.`,
					"error",
				)
				return
			}

			const compactAndSwitch = needsImageStrip()
				? "Compact conversation and continue"
				: "Compact conversation and switch"
			const startNewSession = "Start a new session"
			const choice = await ctx.ui.select(
				`Context is ${excess.toLocaleString()} tokens over ${event.model.id}'s safe limit (${tokens.toLocaleString()} current vs ${limit.toLocaleString()} safe)`,
				ctx.mode === "tui" ? [compactAndSwitch, startNewSession] : [compactAndSwitch],
			)

			if (choice === compactAndSwitch) {
				try {
					await new Promise<void>((resolve, reject) => {
						ctx.compact({ force: true, onComplete: () => resolve(), onError: reject })
					})
				} catch (error) {
					console.error("[model-switch] compaction before model switch failed:", error)
					ctx.ui.notify("Compaction failed; the previous model remains active.", "error")
					return
				}

				const postCompaction = await refreshLatestMessagesFromSession(ctx, { preserveStripped: true })
				if (postCompaction.status !== "ok") {
					ctx.ui.notify("Could not load the compacted context; the previous model remains active.", "error")
					return
				}
				const compactedTokens = resolveContextTokens(ctx.getContextUsage?.(), postCompaction.messages)
				if (compactedTokens != null && !contextFitsModel(compactedTokens, effectiveTarget.contextWindow)) {
					ctx.ui.notify(
						"Compaction did not reduce context enough for this model; the previous model remains active.",
						"error",
					)
					return
				}
				if (needsImageStrip()) {
					await offerStripAndSwitch()
				} else if (await switchToValidatedTarget()) {
					ctx.ui.notify(`Compacted context and switched to ${refFromModel(event.model)}.`, "info")
				}
				return
			}

			if (choice === startNewSession) {
				if (!(await startNewSessionWithModel(ctx.sessionManager, event.model))) {
					ctx.ui.notify("Could not start a new session; the previous model remains active.", "error")
				}
				return
			}

			ctx.ui.notify("Model switch cancelled.", "info")
			return
		}

		if (needsImageStrip()) await offerStripAndSwitch()
	})
}
