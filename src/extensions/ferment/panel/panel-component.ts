import type { Theme } from "@earendil-works/pi-coding-agent"
import { type Component, type Focusable, type TUI, matchesKey } from "@earendil-works/pi-tui"
import type { HistoryView } from "./history-view.js"
import { divider, padText, panelLine, plainWidth, truncateText } from "./layout.js"
import { ProgressViewState, handleProgressInput, renderProgressView } from "./progress-view.js"
import type { PanelSnapshot } from "./snapshot.js"
import type { FermentTrace } from "./trace.js"

export type FermentPanelView = "progress" | "history"

export interface FermentPanelComponentOptions {
	tui: TUI
	theme: Theme
	trace: FermentTrace
	history: HistoryView
	getSnapshot(): PanelSnapshot | undefined
	getView(): FermentPanelView
	setView(view: FermentPanelView): void
	requestRender(): void
	closeFocus(): void
	toggleFocus(): void
	isFocused(): boolean
}

export class FermentPanelComponent implements Component, Focusable {
	focused = false
	private readonly progressState = new ProgressViewState()

	constructor(private readonly opts: FermentPanelComponentOptions) {}

	setView(view: FermentPanelView): void {
		this.opts.setView(view)
		if (view === "progress") this.progressState.resetToActive(this.opts.getSnapshot())
		this.invalidate()
		this.opts.requestRender()
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.opts.closeFocus()
			return
		}
		if (matchesKey(data, "ctrl+\\")) {
			this.opts.toggleFocus()
			return
		}
		if (matchesKey(data, "h")) {
			this.setView("history")
			return
		}
		if (matchesKey(data, "p")) {
			this.setView("progress")
			return
		}

		const view = this.opts.getView()
		const handled =
			view === "history"
				? this.opts.history.handleInput(data)
				: handleProgressInput(data, this.opts.getSnapshot(), this.progressState)
		if (handled) {
			this.invalidate()
			this.opts.requestRender()
		}
	}

	render(width: number): string[] {
		const theme = this.opts.theme
		const rows = Math.max(8, this.opts.tui.terminal.rows)
		const contentWidth = Math.max(20, width - 2)
		const focused = this.focused || this.opts.isFocused()
		const view = this.opts.getView()
		const snapshot = this.opts.getSnapshot()
		const lines: string[] = []

		lines.push(panelLine(theme, width, this.renderHeader(contentWidth, view, snapshot), focused))
		lines.push(panelLine(theme, width, divider(theme, contentWidth), focused))

		const bodyRows = Math.max(1, rows - lines.length)
		const body =
			view === "history"
				? this.opts.history.render(contentWidth, bodyRows, theme)
				: renderProgressView(snapshot, this.progressState, this.opts.trace, contentWidth, bodyRows, theme)
		for (const line of body) lines.push(panelLine(theme, width, line, focused))

		return lines.slice(0, rows)
	}

	invalidate(): void {}

	dispose(): void {}

	private renderHeader(width: number, view: FermentPanelView, snapshot: PanelSnapshot | undefined): string {
		const theme = this.opts.theme
		const title = `${theme.fg("accent", "▍ FERMENT")} ${theme.fg("muted", "·")} ${theme.fg("accent", view.toUpperCase())}`
		const bits: string[] = []
		if (snapshot) {
			bits.push(snapshot.name)
			if (snapshot.grade) bits.push(snapshot.grade)
		}
		const right = theme.fg("dim", truncateText(bits.join(" · "), Math.max(0, width - 18)))
		const gap = Math.max(1, width - plainWidth(title) - plainWidth(right))
		return padText(`${title}${" ".repeat(gap)}${right}`, width)
	}
}
