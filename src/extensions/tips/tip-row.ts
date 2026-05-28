import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth } from "@earendil-works/pi-tui"
import type { TipCandidate } from "./types.js"

const MAX_TIP_WIDTH = 96

export class TipRow {
	constructor(
		private readonly getTip: () => TipCandidate | undefined,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const tip = this.getTip()
		if (!tip) return []
		return renderTipRow(tip, this.theme, width)
	}

	invalidate(): void {}
}

export function renderTipRow(tip: TipCandidate, theme: Theme, width: number): string[] {
	return renderTipText(tip.message, theme, width)
}

export function renderTipText(message: string, theme: Theme, width: number): string[] {
	const availableWidth = Math.max(0, Math.floor(width))
	if (availableWidth === 0) return []

	const contentWidth = Math.min(availableWidth, MAX_TIP_WIDTH)
	const content = formatTipContent(message, theme)
	const truncated = truncateToWidth(content, contentWidth, "...")

	return [truncated]
}

function formatTipContent(message: string, theme: Theme): string {
	return `${theme.fg("muted", "Tip:")} ${formatTipMessage(message, theme)}`
}

export function formatTipMessage(message: string, theme: Theme): string {
	return message
		.split(/(`[^`\n]+`)/g)
		.map((part) =>
			part.startsWith("`") && part.endsWith("`") ? theme.fg("accent", part.slice(1, -1)) : theme.fg("muted", part),
		)
		.join("")
}
