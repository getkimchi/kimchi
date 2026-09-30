import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { wrapTextWithAnsi } from "@earendil-works/pi-tui"
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
			const contentWidth = Math.max(1, width - 2)
			const rule = theme.fg("accent", "─".repeat(contentWidth))
			const lines: string[] = [rule, ` ${theme.bold("Status")}`, ""]
			for (const row of rows) {
				if (row === "") {
					lines.push("")
					continue
				}
				for (const line of wrapTextWithAnsi(row, contentWidth)) {
					lines.push(` ${theme.fg("text", line)}`)
				}
			}
			lines.push("", ` ${theme.fg("muted", "press any key to close")}`, rule)
			cachedLines = truncateLinesToWidth(lines, width)
			cachedWidth = width
			return cachedLines
		},
	}
}
