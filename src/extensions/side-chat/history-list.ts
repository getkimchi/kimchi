/**
 * In-panel list of the session's side chats, opened from the header's ≡.
 *
 * Wraps pi-tui's SelectList (arrow keys, enter, esc, click, wheel) and
 * forwards extension shortcuts so the focus keys still work while it has focus.
 */

import type { Theme } from "@earendil-works/pi-coding-agent"
import {
	type Component,
	type Focusable,
	SelectList,
	type SelectListTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui"

export interface HistoryItem {
	id: string
	label: string
	current: boolean
}

export interface HistoryListOptions {
	theme: Theme
	onPick(id: string): void
	onCancel(): void
	onShortcut(data: string): boolean
}

const MAX_VISIBLE = 50

export class HistoryList implements Component, Focusable {
	/** Set by the TUI when focus changes. */
	focused = false
	private list?: SelectList
	private ids: string[] = []
	private selected = 0

	constructor(private readonly options: HistoryListOptions) {}

	setItems(items: readonly HistoryItem[]): void {
		const list = new SelectList(
			items.map((item) => ({ value: item.id, label: item.label, ...(item.current ? { description: "open" } : {}) })),
			MAX_VISIBLE,
			selectListTheme(this.options.theme),
		)
		list.onSelect = (item) => this.options.onPick(item.value)
		list.onCancel = () => this.options.onCancel()
		list.onSelectionChange = (item) => {
			this.selected = Math.max(0, this.ids.indexOf(item.value))
		}
		this.list = list
		this.ids = items.map((item) => item.id)
		this.selected = 0
	}

	/** Move the highlight by wheel ticks (the side pane intercepts the wheel before layout dispatch). */
	scrollBy(delta: number): void {
		if (!this.list || this.ids.length === 0) return
		this.selected = Math.max(0, Math.min(this.ids.length - 1, this.selected + delta))
		this.list.setSelectedIndex(this.selected)
	}

	render(width: number): string[] {
		return this.list?.render(Math.max(1, width)) ?? []
	}

	handleInput(data: string): void {
		if (this.options.onShortcut(data)) return
		this.list?.handleInput(data)
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.list?.handleMouse(event)
	}

	invalidate(): void {
		this.list?.invalidate()
	}
}

/** `getSelectListTheme()` reads the module-global theme; build it from the one passed in. */
function selectListTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	}
}
