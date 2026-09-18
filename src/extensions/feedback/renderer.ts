import type { MessageRenderer } from "@earendil-works/pi-coding-agent"
import { Container, Text } from "@earendil-works/pi-tui"

export type FeedbackSentiment = "positive" | "negative"

export interface FeedbackSummaryDetails {
	sentiment: FeedbackSentiment
	reason: string
}

export interface ModelSwitchSummaryDetails {
	model: string
	reason: string
}

const INDENT = "  "

function isFeedbackSummary(details: unknown): details is FeedbackSummaryDetails {
	if (!details || typeof details !== "object") return false
	const d = details as Record<string, unknown>
	return (d.sentiment === "positive" || d.sentiment === "negative") && typeof d.reason === "string"
}

function isModelSwitchSummary(details: unknown): details is ModelSwitchSummaryDetails {
	if (!details || typeof details !== "object") return false
	const d = details as Record<string, unknown>
	return typeof d.model === "string" && typeof d.reason === "string"
}

export const feedbackSummaryRenderer: MessageRenderer<FeedbackSummaryDetails | ModelSwitchSummaryDetails> = (
	message,
	_options,
	theme,
) => {
	const details = message.details as unknown

	if (isFeedbackSummary(details)) {
		const sentimentLabel = details.sentiment === "positive" ? "Good" : "Bad"
		const container = new Container()
		container.addChild(new Text(INDENT + theme.fg("muted", "Thanks, feedback received!"), 0, 0))
		container.addChild(new Text(INDENT + theme.fg("muted", `Your rating: ${sentimentLabel}`), 0, 0))
		container.addChild(new Text(INDENT + theme.fg("muted", `Reason: ${details.reason}`), 0, 0))
		return container
	}

	if (isModelSwitchSummary(details)) {
		const container = new Container()
		if (details.reason.length > 0) {
			container.addChild(new Text(INDENT + theme.fg("muted", `Reason: ${details.reason}`), 0, 0))
		} else {
			container.addChild(
				new Text(INDENT + theme.fg("dim", `Tell us why you switched to ${details.model} (Ctrl+R)`), 0, 0),
			)
		}
		return container
	}

	return undefined
}
