import type { EntryRenderer } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"
import type { FeedbackSentiment } from "./dialog.js"

export interface FeedbackSummaryDetails {
	sentiment: FeedbackSentiment
	reason: string
}

export interface ModelSwitchSummaryDetails {
	model: string
	reason: string
}

const INDENT = "  "

function isFeedbackSummary(data: unknown): data is FeedbackSummaryDetails {
	if (!data || typeof data !== "object") return false
	const d = data as Record<string, unknown>
	return (d.sentiment === "positive" || d.sentiment === "negative") && typeof d.reason === "string"
}

function isModelSwitchSummary(data: unknown): data is ModelSwitchSummaryDetails {
	if (!data || typeof data !== "object") return false
	const d = data as Record<string, unknown>
	return typeof d.model === "string" && typeof d.reason === "string"
}

/**
 * Renders both feedback summaries and model-switch summaries. These are custom
 * *entries*, not custom messages: feedback text is user input and must never
 * reach the LLM context, so it is persisted via `pi.appendEntry()` and rendered
 * here rather than sent through `pi.sendMessage()`.
 */
export const feedbackSummaryRenderer: EntryRenderer<FeedbackSummaryDetails | ModelSwitchSummaryDetails> = (
	entry,
	_options,
	theme,
) => {
	const data = entry.data as unknown

	if (isFeedbackSummary(data)) {
		const sentimentLabel = data.sentiment === "positive" ? "Good" : "Bad"
		const container = new Container()
		container.addChild(new Text(INDENT + theme.fg("muted", "Thanks, feedback received!"), 0, 0))
		container.addChild(new Text(INDENT + theme.fg("muted", `Your rating: ${sentimentLabel}`), 0, 0))
		// Skip the reason line entirely when the user submitted without one,
		// rather than rendering a dangling "Reason:" label.
		if (data.reason.length > 0) {
			container.addChild(new Text(INDENT + theme.fg("muted", `Reason: ${data.reason}`), 0, 0))
		}
		return container
	}

	if (isModelSwitchSummary(data)) {
		const container = new Container()
		if (data.reason.length > 0) {
			container.addChild(new Text(INDENT + theme.fg("muted", `Reason: ${data.reason}`), 0, 0))
		} else {
			container.addChild(new Text(INDENT + theme.fg("dim", `Tell us why you switched to ${data.model} (Ctrl+R)`), 0, 0))
		}
		return container
	}

	return undefined
}
