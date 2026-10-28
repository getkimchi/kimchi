/**
 * Floating "Add to side chat" pill under a settled transcript selection.
 *
 * Painted by a harness compositor next to the selection's end (or above its
 * start when there is no room below); a left click on it hands the selected
 * text over and swallows the matching release so the renderer doesn't start
 * a new selection.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { type Frame, isLeftPress, type RawMouseEvent, rectOf, type SideChatHost } from "./harness.js"
import { compositeKeepingCursor } from "./line-paint.js"

export interface SelectionPillOptions {
	host: () => SideChatHost | undefined
	theme: Theme
	onAdd(text: string): void
}

export class SelectionPill {
	/** Where the pill was last painted; undefined when hidden. */
	private placed?: { row: number; column: number; width: number }
	private swallowRelease = false

	constructor(private readonly options: SelectionPillOptions) {}

	paint(screen: string[], frame: Frame, width: number): string[] {
		this.placed = undefined
		const selection = this.options.host()?.settledSelection()
		const scrollView = selection?.bounds.start.scrollView
		if (!selection || !scrollView) return screen
		const rect = rectOf(frame, scrollView)
		if (!rect || rect.height <= 0) return screen
		const top = rect.y
		const bottom = top + rect.height - 1
		const toScreen = (row: number) => top + row - scrollView.scrollTop
		let row = toScreen(selection.bounds.end.row) + 1
		if (row > bottom) row = toScreen(selection.bounds.start.row) - 1
		if (row < top || row > bottom) row = Math.max(top, Math.min(bottom, toScreen(selection.bounds.end.row)))
		const label = this.label()
		const labelWidth = visibleWidth(label)
		const maxColumn = rect.x + rect.width - labelWidth - 1
		if (maxColumn < rect.x) return screen
		const column = Math.max(rect.x, Math.min(maxColumn, rect.x + selection.bounds.end.col - labelWidth + 1))
		const result = [...screen]
		result[row] = compositeKeepingCursor(result[row] ?? "", label, column, labelWidth, width)
		this.placed = { row, column, width: labelWidth }
		return result
	}

	/** Mouse interceptor: consumes a left press on the pill and its release. */
	handleMouse(event: RawMouseEvent): boolean {
		if (this.swallowRelease && event.release) {
			this.swallowRelease = false
			return true
		}
		const placed = this.placed
		if (!placed || !isLeftPress(event)) return false
		if (event.y !== placed.row || event.x < placed.column || event.x >= placed.column + placed.width) return false
		const host = this.options.host()
		const text = host?.settledSelection()?.text
		host?.clearSelection()
		this.swallowRelease = true
		if (text) this.options.onAdd(text)
		return true
	}

	private label(): string {
		const { theme } = this.options
		return theme.bg("selectedBg", theme.fg("accent", theme.bold(" + Add to side chat ")))
	}
}
