/**
 * Side chat header: focus marker, title, and clickable ≡ (history) and ✕
 * (close) buttons pinned to the right edge. The burger is "≡" rather than
 * "☰": terminals disagree on ☰'s cell width (Unicode 16 made it wide), which
 * would shift every column after it.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import {
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui"

export type HeaderAction = "history" | "close"

const BUTTONS: readonly { action: HeaderAction; glyph: string }[] = [
	{ action: "history", glyph: "≡" },
	{ action: "close", glyph: "✕" },
]
/** Each button is its glyph padded by one cell on both sides, for an easier click target. */
const BUTTON_WIDTH = 3
const BUTTONS_WIDTH = BUTTONS.length * BUTTON_WIDTH

export interface PanelHeaderOptions {
	theme: Theme
	isFocused(): boolean
	title(): string
	/** Highlights the ≡ button while the history list is open. */
	isHistoryOpen(): boolean
	onAction(action: HeaderAction): void
}

export class PanelHeader implements Component {
	constructor(private readonly options: PanelHeaderOptions) {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width)
		const { theme } = this.options
		const focused = this.options.isFocused()
		const marker = focused ? theme.fg("accent", "●") : theme.fg("dim", "○")
		const label = theme.bold(theme.fg(focused ? "accent" : "muted", " Side chat"))
		const left = ` ${marker}${label}${theme.fg("dim", ` · ${this.options.title()}`)}`
		if (safeWidth <= BUTTONS_WIDTH) return [truncateToWidth(left, safeWidth)]
		const leftWidth = safeWidth - BUTTONS_WIDTH
		const title = truncateToWidth(left, leftWidth)
		const gap = " ".repeat(Math.max(0, leftWidth - visibleWidth(title)))
		const buttons = BUTTONS.map(({ action, glyph }) => {
			const active = action === "history" && this.options.isHistoryOpen()
			return theme.fg(active ? "accent" : "muted", ` ${glyph} `)
		}).join("")
		return [`${title}${gap}${buttons}`]
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined
		const action = actionAt(event.x, event.width)
		if (!action) return undefined
		if (event.type === "click") this.options.onAction(action)
		return { handled: true }
	}

	invalidate(): void {}
}

/** Button under local column `x` of a header `width` cells wide. */
export function actionAt(x: number, width: number): HeaderAction | undefined {
	if (width <= BUTTONS_WIDTH) return undefined
	const offset = x - (width - BUTTONS_WIDTH)
	if (offset < 0 || offset >= BUTTONS_WIDTH) return undefined
	return BUTTONS[Math.floor(offset / BUTTON_WIDTH)]?.action
}
