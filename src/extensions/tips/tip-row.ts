import type { Theme } from "@earendil-works/pi-coding-agent"
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import type { TipCandidate, TipTone } from "./types.js"

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
	return renderTipText(tip.message, theme, width, { tone: tip.tone, showPrefix: tip.showPrefix })
}

interface RenderTipTextOptions {
	tone?: TipTone
	showPrefix?: boolean
}

export function renderTipText(
	message: string,
	theme: Theme,
	width: number,
	options: RenderTipTextOptions = {},
): string[] {
	const availableWidth = Math.max(0, Math.floor(width))
	if (availableWidth === 0) return []

	const content = formatTipContent(message, theme, options)
	if (options.showPrefix === false) {
		return wrapTextWithAnsi(content, availableWidth)
	}

	const contentWidth = Math.min(availableWidth, MAX_TIP_WIDTH)
	const truncated = truncateToWidth(content, contentWidth, "...")

	return [truncated]
}

function formatTipContent(message: string, theme: Theme, options: RenderTipTextOptions): string {
	const tone = options.tone ?? "default"
	const formatted = formatTipMessage(message, theme, tone)
	if (options.showPrefix === false) return formatted
	return `${theme.fg(colorForTone(tone), "Tip:")} ${formatted}`
}

export function formatTipMessage(message: string, theme: Theme, tone: TipTone = "default"): string {
	const textColor = colorForTone(tone)
	return message
		.split(/(`[^`\n]+`)/g)
		.map((part) =>
			part.startsWith("`") && part.endsWith("`") ? theme.fg("accent", part.slice(1, -1)) : theme.fg(textColor, part),
		)
		.join("")
}

function colorForTone(tone: TipTone): "muted" | "warning" | "error" {
	if (tone === "error") return "error"
	return tone === "warning" ? "warning" : "muted"
}
