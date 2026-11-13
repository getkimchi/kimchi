/**
 * Floating "Add to side chat" pill under a settled transcript selection.
 *
 * Painted by a harness compositor next to the selection's end (or above its
 * start when there is no room below); a left click on it hands the selected
 * text over and swallows the matching release so the renderer doesn't start
 * a new selection.
 *
 * Painting reads the selection bounds only — never the extracted text:
 * text extraction reads the renderer's *previous* layout and can come back
 * empty for a frame while the transcript streams (letting the pill blip),
 * and the text is only needed when the pill is clicked. When the anchor
 * rows scroll out of the transcript viewport, the pill hides instead of
 * clamping into view.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import { type Component, visibleWidth } from "@earendil-works/pi-tui"
import { type Frame, findBox, isLeftPress, type RawMouseEvent, rectOf, type SideChatHost } from "./harness.js"
import { compositeKeepingCursor } from "./line-paint.js"

export interface SelectionPillOptions {
	host: () => SideChatHost | undefined
	theme: Theme
	/**
	 * Pane the pill never paints over: quoting the side chat back into itself
	 * makes no sense, so selections inside it get no pill. Undefined when no
	 * side chat is open.
	 */
	excludeWithin: () => Component | undefined
	onAdd(text: string): void
}

export class SelectionPill {
	/** Where the pill was last painted; undefined when hidden. */
	private placed?: { row: number; column: number; width: number }
	private swallowRelease = false

	constructor(private readonly options: SelectionPillOptions) {}

	paint(screen: string[], frame: Frame, width: number): string[] {
		this.placed = undefined
		const bounds = this.options.host()?.selectionBounds()
		const scrollView = bounds?.start.scrollView
		if (!bounds || !scrollView) return screen
		const excluded = this.options.excludeWithin()
		if (excluded) {
			const excludedBox = findBox(frame.root, (box) => box.component === excluded)
			if (excludedBox && findBox(excludedBox, (box) => box.component === scrollView)) return screen
		}
		const rect = rectOf(frame, scrollView)
		if (!rect || rect.height <= 0) return screen
		const top = rect.y
		const bottom = top + rect.height - 1
		const toScreen = (row: number) => top + row - scrollView.scrollTop
		let row = toScreen(bounds.end.row) + 1
		if (row > bottom) row = toScreen(bounds.start.row) - 1
		if (row < top || row > bottom) {
			// Selection scrolled out of the transcript viewport: hide, don't float.
			// A selection TALLER than the viewport straddles it — its text is all
			// that's on screen, so pin the pill to the end's edge instead.
			const straddles = toScreen(bounds.start.row) <= top && toScreen(bounds.end.row) >= bottom
			if (!straddles) return screen
			row = Math.max(top, Math.min(bottom, toScreen(bounds.end.row)))
		}
		const label = this.label()
		const labelWidth = visibleWidth(label)
		const maxColumn = rect.x + rect.width - labelWidth - 1
		if (maxColumn < rect.x) return screen
		const column = Math.max(rect.x, Math.min(maxColumn, rect.x + bounds.end.col - labelWidth + 1))
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
		// The pill can be painted while text extraction fails. Pass that click
		// through untouched (the pre-bounds-paint behavior): transient mid-stream
		// failures recover next frame, and permanently text-less selections
		// (e.g. blank lines) must not become a click black hole.
		if (!text) return false
		host?.clearSelection()
		// Disarm the rect now: the pixels repaint only on the next compositor
		// pass, and a second click on the dead pill must start a new selection.
		this.placed = undefined
		this.swallowRelease = true
		this.options.onAdd(text)
		return true
	}

	private label(): string {
		const { theme } = this.options
		return theme.bg("selectedBg", theme.fg("accent", theme.bold(" + Add to side chat ")))
	}
}
