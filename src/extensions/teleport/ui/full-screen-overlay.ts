import { type Component, truncateToWidth } from "@earendil-works/pi-tui"

interface ScreenTui {
	requestRender(force?: boolean): void
	terminal: { rows: number; cols?: number }
}

export interface FullScreenOverlayOptions {
	/** Inner panel width as a percentage of terminal width (default 70). */
	widthPercent?: number
	/** Hard minimum inner width in columns (default 20). */
	minInnerWidth?: number
}

/**
 * Wraps an inner panel so its bordered output is centered inside a full-terminal
 * canvas. Every returned line spans the full terminal width and the total line
 * count equals the terminal height, which prevents underlying chat content from
 * bleeding around the panel and prevents row-shift when the inner panel's height
 * changes during navigation.
 */
export class FullScreenOverlay implements Component {
	constructor(
		private readonly inner: Component,
		private readonly tui: ScreenTui,
		private readonly opts: FullScreenOverlayOptions = {},
	) {}

	handleInput(data: string): void {
		this.inner.handleInput?.(data)
	}

	invalidate(): void {
		this.inner.invalidate?.()
	}

	dispose(): void {
		const inner = this.inner as Component & { dispose?: () => void }
		inner.dispose?.()
	}

	render(width: number): string[] {
		const termRows = Math.max(1, this.tui.terminal.rows)
		const widthPercent = this.opts.widthPercent ?? 70
		const minInner = this.opts.minInnerWidth ?? 20
		const innerW = Math.min(width, Math.max(minInner, Math.floor((width * widthPercent) / 100)))
		const leftPad = Math.max(0, Math.floor((width - innerW) / 2))
		const rightPadW = Math.max(0, width - innerW - leftPad)

		const innerLines = this.inner.render(innerW)
		const panelH = innerLines.length
		const topPad = Math.max(0, Math.floor((termRows - panelH) / 2))
		const usedRows = topPad + panelH
		const bottomPad = Math.max(0, termRows - usedRows)

		const blankRow = " ".repeat(width)
		const left = " ".repeat(leftPad)
		const rightPad = " ".repeat(rightPadW)
		const out: string[] = []
		for (let i = 0; i < topPad; i++) out.push(blankRow)
		for (const line of innerLines) {
			const normalized = truncateToWidth(line, innerW, "", true)
			out.push(left + normalized + rightPad)
		}
		for (let i = 0; i < bottomPad; i++) out.push(blankRow)
		return out
	}
}

export function wrapFullScreen(inner: Component, tui: ScreenTui, opts?: FullScreenOverlayOptions): FullScreenOverlay {
	return new FullScreenOverlay(inner, tui, opts)
}

export const FULL_SCREEN_OVERLAY_OPTIONS = {
	overlay: true as const,
	overlayOptions: { anchor: "top-left" as const, width: "100%" as const, maxHeight: "100%" as const },
}
