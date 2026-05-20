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
	const availableWidth = Math.max(0, Math.floor(width))
	if (availableWidth === 0) return []

	const contentWidth = Math.min(availableWidth, MAX_TIP_WIDTH)
	const content = formatTipContent(tip, theme)
	const truncated = truncateToWidth(content, contentWidth, "...")

	return [truncated]
}

function formatTipContent(tip: TipCandidate, theme: Theme): string {
	return `${theme.fg("success", "Tip:")} ${formatTipMessage(tip, theme)}`
}

function formatTipMessage(tip: TipCandidate, theme: Theme): string {
	return tip.message
		.split(/(`[^`\n]+`)/g)
		.map((part) =>
			part.startsWith("`") && part.endsWith("`") ? theme.fg("accent", part.slice(1, -1)) : theme.fg("muted", part),
		)
		.join("")
}
