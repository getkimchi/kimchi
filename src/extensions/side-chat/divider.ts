/**
 * Draggable 1-column divider between the main session and the side chat.
 *
 * The divider component only reserves its column in the HStack; the line
 * itself is painted over the panel's full height by a compositor (a plain
 * component can't know the stretched row count). Pressing on the column and
 * dragging resizes the side panel; a double-click resets the default split.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import {
	type Frame,
	isLeftPress,
	isMouseMotion,
	MAIN_PANEL_MIN_WIDTH,
	type RawMouseEvent,
	rectOf,
	SIDE_PANEL_MIN_WIDTH,
	type SideChatHost,
} from "./harness.js"
import { compositeKeepingCursor } from "./line-paint.js"

const DOUBLE_CLICK_MS = 400
const GRIP_ROWS = 3

class DividerColumn implements Component {
	render(): string[] {
		return [" "]
	}
	invalidate(): void {}
}

export interface PaneDividerOptions {
	host: SideChatHost
	theme: Theme
	/** The side panel's root, used for the divider's vertical extent. */
	panelRoot: Component
	/** Called with the new side width, or `undefined` to reset the default split. */
	onResize(width: number | undefined): void
}

export class PaneDivider {
	readonly component: Component = new DividerColumn()
	private dragging = false
	private lastPress = 0
	/** Terminal width at drag start; the layout is rebuilt on every resize step. */
	private frameWidth = 0

	constructor(private readonly options: PaneDividerOptions) {}

	paint(screen: string[], frame: Frame, width: number): string[] {
		const column = rectOf(frame, this.component)
		const panel = rectOf(frame, this.options.panelRoot)
		if (!column || !panel) return screen
		const { theme } = this.options
		const color = this.dragging ? "accent" : "borderMuted"
		const top = panel.y
		const height = panel.height
		const gripStart = top + Math.floor((height - GRIP_ROWS) / 2)
		const result = [...screen]
		for (let row = top; row < Math.min(result.length, top + height); row++) {
			const grip = row >= gripStart && row < gripStart + GRIP_ROWS
			const glyph = theme.fg(grip ? (this.dragging ? "accent" : "muted") : color, grip ? "┃" : "│")
			result[row] = compositeKeepingCursor(result[row] ?? "", glyph, column.x, 1, width)
		}
		return result
	}

	/** Mouse interceptor: owns presses on the divider column and the drag that follows. */
	handleMouse(event: RawMouseEvent): boolean {
		if (this.dragging) {
			if (event.release) {
				this.dragging = false
				this.options.host.requestRender()
			} else if (isMouseMotion(event)) {
				this.resizeTo(event.x)
			}
			return true
		}
		if (!isLeftPress(event) || !this.hits(event)) return false
		const now = Date.now()
		if (now - this.lastPress <= DOUBLE_CLICK_MS) {
			this.lastPress = 0
			this.options.onResize(undefined)
			return true
		}
		this.lastPress = now
		this.frameWidth = this.options.host.frame()?.width ?? 0
		this.dragging = true
		this.options.host.requestRender()
		return true
	}

	private hits(event: RawMouseEvent): boolean {
		const frame = this.options.host.frame()
		const column = rectOf(frame, this.component)
		const panel = rectOf(frame, this.options.panelRoot)
		if (!column || !panel) return false
		return event.x === column.x && event.y >= panel.y && event.y < panel.y + panel.height
	}

	private resizeTo(pointerX: number): void {
		if (this.frameWidth <= 0) return
		const max = this.frameWidth - 1 - MAIN_PANEL_MIN_WIDTH
		const width = Math.max(SIDE_PANEL_MIN_WIDTH, Math.min(max, this.frameWidth - pointerX - 1))
		this.options.onResize(width)
	}
}
