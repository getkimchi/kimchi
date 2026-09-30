import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui"
import { truncateLinesToWidth } from "../../truncate-lines.js"

/**
 * Read-only Status panel (see CONTEXT.md "Status panel").
 *
 * Rendered via `ctx.ui.custom`; any key press (including Esc) dismisses it.
 * The rows are computed on open — the panel is a snapshot, not a live view.
 */
export function createStatusPanelComponent(theme: Theme, rows: string[], done: () => void): Component {
	let cachedLines: string[] | undefined
	let cachedWidth = 0

	return {
		invalidate(): void {
			cachedLines = undefined
		},

		handleInput(_data: string): void {
			// any key dismisses the read-only panel
			done()
		},

		render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines
			// Bordered box: accent `─` rules capped with corners, `│` side borders
			// wrapping every row (one space of inner padding on each side).
			const contentWidth = Math.max(1, width - 4)
			const border = (s: string): string => theme.fg("accent", s)
			const topRule = border(`╭${"─".repeat(contentWidth + 2)}╮`)
			const bottomRule = border(`╰${"─".repeat(contentWidth + 2)}╯`)
			const boxRow = (styled: string): string => {
				const pad = " ".repeat(Math.max(0, contentWidth - visibleWidth(styled)))
				return `${border("│")} ${styled}${pad} ${border("│")}`
			}
			const lines: string[] = [topRule, boxRow(theme.bold("Status")), boxRow("")]
			for (const row of rows) {
				if (row === "") {
					lines.push(boxRow(""))
					continue
				}
				for (const line of wrapTextWithAnsi(row, contentWidth)) {
					lines.push(boxRow(theme.fg("text", line)))
				}
			}
			lines.push(boxRow(""), boxRow(theme.fg("muted", "press any key to close")), bottomRule)
			cachedLines = truncateLinesToWidth(lines, width)
			cachedWidth = width
			return cachedLines
		},
	}
}
