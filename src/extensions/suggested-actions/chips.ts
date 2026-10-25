/**
 * The row of suggested-action chips under the main editor:
 * `( ◉ Watch PR #1531 ) ×`, one chip per suggestion. A click on a chip runs it,
 * a click on `×` dismisses it; a chip whose action is running is shown as
 * `◌ Watching PR #1531` and ignores clicks.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import {
	type Component,
	MouseRegion,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui"
import type { Suggestion } from "./detect.js"

export interface SuggestionChipsOptions {
	suggestions: () => readonly Suggestion[]
	onRun(suggestion: Suggestion): void
	onDismiss(suggestion: Suggestion): void
}

interface HitRegion {
	start: number
	end: number
	act(): void
}

const GAP = "   "

class SuggestionChipRow implements Component {
	/** Clickable column ranges of the last render. */
	private regions: HitRegion[] = []

	constructor(
		private readonly theme: Theme,
		private readonly options: SuggestionChipsOptions,
	) {}

	render(width: number): string[] {
		const theme = this.theme
		const options = this.options
		this.regions = []
		const suggestions = options.suggestions()
		if (!suggestions.length) return []
		let line = " "
		let column = 1
		for (const suggestion of suggestions) {
			const text = suggestion.watching ? ` ◌ Watching ${suggestion.label} ` : ` ◉ Watch ${suggestion.label} `
			const chip = theme.bg(
				"selectedBg",
				suggestion.watching ? theme.fg("dim", text) : theme.fg("accent", theme.bold(text)),
			)
			const chipWidth = visibleWidth(text)
			const separator = column > 1 ? GAP : ""
			// Chips that do not fit are left out whole rather than cut.
			if (column + separator.length + chipWidth + 2 > Math.max(1, width)) break
			column += separator.length
			if (!suggestion.watching)
				this.regions.push({ start: column, end: column + chipWidth, act: () => options.onRun(suggestion) })
			column += chipWidth + 1
			this.regions.push({ start: column, end: column + 1, act: () => options.onDismiss(suggestion) })
			column += 1
			line += `${separator}${chip} ${theme.fg("dim", "×")}`
		}
		return [line]
	}

	handleClick(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" || event.y !== 0 || (event.type !== "press" && event.type !== "click")) return undefined
		const region = this.regions.find(({ start, end }) => event.x >= start && event.x < end)
		if (!region) return undefined
		if (event.type === "click") region.act()
		return { handled: true }
	}

	invalidate(): void {}
}

export function createSuggestionChips(theme: Theme, options: SuggestionChipsOptions): Component {
	const row = new SuggestionChipRow(theme, options)
	return new MouseRegion(row, (event) => row.handleClick(event))
}
