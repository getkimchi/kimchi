import type { Api, Model } from "@earendil-works/pi-ai"
import { isAutoRoutedModel } from "./auto-model/constants.js"

/**
 * Whether a model accepts image attachments, read from the live model's
 * input modalities (`model.input`). This is the single capability source for
 * the submit-time vision gate, switch-candidate filtering, and the /model
 * selector's IMG column — a catalog lookup by slug could disagree with the
 * model actually in use (provider/id collisions, catalog refresh lag),
 * silently dropping attachments.
 *
 * Backend-routed virtual models (`kimchi-dev/auto*`) are image-capable
 * regardless of their descriptor: the backend picks a concrete model per
 * request, so the descriptor's modalities do not reflect the routed pool.
 */
export function modelSupportsImages(
	model: { provider: string; id: string; input: readonly string[] } | undefined | null,
): boolean {
	if (!model) return false
	if (isAutoRoutedModel(model)) return true
	return model.input.includes("image")
}

/**
 * Whether the submit-time vision gate must engage for the current model: a
 * concrete model whose input modalities lack images.
 *
 * Backend-routed virtual models bypass the gate explicitly: the backend
 * resolves a concrete model per request and accepts image input, so the gate
 * neither fires for them nor offers them as a candidate.
 */
export function needsVisionSwitch(model: Pick<Model<Api>, "provider" | "id" | "input"> | undefined | null): boolean {
	if (!model) return false
	if (isAutoRoutedModel(model)) return false
	return !model.input.includes("image")
}

/**
 * Vision-capable switch candidates for the gate dialog: available models that
 * accept image input, with backend-routed virtual models excluded (the
 * concrete pick is not guaranteed to be a vision model, so switching to Auto
 * cannot guarantee image support). Consistent with findVisionModel's
 * candidate rule in strip-images.
 */
export function visionModelCandidates(available: readonly Model<Api>[]): Model<Api>[] {
	return available.filter((model) => !isAutoRoutedModel(model) && model.input.includes("image"))
}

/**
 * Humanized context window for table rows and dialog badges: `200k`, `1M`.
 * Sub-1000 windows render as-is.
 */
/**
 * Renders a context-window size exactly the way the /model capability table
 * renders it (upstream `formatTokens` plus the `.0M` → `M` cleanup from the
 * kimchi patch), so the same window never renders differently between the
 * /model table and the vision-switch table.
 */
export function humanizeContextWindow(contextWindow: number): string {
	if (contextWindow < 1_000) return `${contextWindow}`
	if (contextWindow < 10_000) return `${(contextWindow / 1_000).toFixed(1)}k`
	if (contextWindow < 1_000_000) return `${Math.round(contextWindow / 1_000)}k`
	if (contextWindow < 10_000_000) {
		return `${(contextWindow / 1_000_000).toFixed(1)}M`.replace(".0M", "M")
	}
	return `${Math.round(contextWindow / 1_000_000)}M`
}
