import type { Api, Model } from "@earendil-works/pi-ai"
import { isAutoModel } from "./router/constants.js"

/**
 * Whether a model accepts image attachments, read from the live model's
 * input modalities (`model.input`). This is the single capability source for
 * the submit-time vision gate, switch-candidate filtering, and the /model
 * selector's IMG column — the clipboard extension's old slug-based catalog
 * lookup could disagree with the model actually in use (provider/id
 * collisions, catalog refresh lag), silently dropping attachments.
 */
export function modelSupportsImages(model: { input: readonly string[] } | undefined | null): boolean {
	return !!model && model.input.includes("image")
}

/**
 * Whether the submit-time vision gate must engage for the current model: a
 * concrete model whose input modalities lack images.
 *
 * Auto bypasses the gate explicitly: the router resolves concrete models
 * downstream and picking Auto from the switch dialog could reproduce the
 * problem, so the gate neither fires for it nor offers it as a candidate.
 */
export function needsVisionSwitch(model: Pick<Model<Api>, "provider" | "id" | "input"> | undefined | null): boolean {
	if (!model) return false
	if (isAutoModel(model)) return false
	return !model.input.includes("image")
}

/**
 * Vision-capable switch candidates for the gate dialog: available models that
 * accept image input, with Auto excluded (the router is not image-aware —
 * picking it can reproduce the problem). Consistent with findVisionModel's
 * candidate rule in strip-images.
 */
export function visionModelCandidates(available: readonly Model<Api>[]): Model<Api>[] {
	return available.filter((model) => !isAutoModel(model) && model.input.includes("image"))
}

/**
 * Humanized context window for table rows and dialog badges: `200k`, `1M`.
 * Sub-1000 windows render as-is.
 */
export function humanizeContextWindow(contextWindow: number): string {
	if (contextWindow >= 1_000_000) {
		const millions = contextWindow / 1_000_000
		// Integral millions render compact; fractional ones keep one decimal.
		return Number.isInteger(millions) ? `${millions}M` : `${millions.toFixed(1)}M`
	}
	if (contextWindow >= 1000) return `${Math.round(contextWindow / 1000)}k`
	return `${contextWindow}`
}
