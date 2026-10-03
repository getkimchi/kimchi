/**
 * Collapsed-by-default notice rendered as an editor widget
 * (`ctx.ui.setWidget`): one dim summary row with a right-aligned
 * "(ctrl+o to expand)" hint, mirroring the collapsed tool-row convention.
 *
 * Widgets are UI-only — unlike custom transcript messages they never enter
 * the session history or the LLM context, and compaction never sees them.
 *
 * Expansion follows the global ctrl+o state (`getToolsExpanded`), read on
 * every render; a left click toggles only this notice until the global
 * state changes again.
 */

import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent"
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { buildAlignedLine } from "./tool-block.js"

export interface CollapsibleNoticeContent {
	/** Dim row shown while collapsed. */
	summary: string
	/** Title shown in place of the summary while expanded. */
	title: string
	/** Detail entries listed under the title while expanded; may contain newlines. */
	entries: readonly string[]
}

export class CollapsibleNotice implements Component {
	private expanded = false
	private lastGlobalExpanded: boolean | undefined

	constructor(
		private readonly theme: Theme,
		private readonly content: () => CollapsibleNoticeContent,
		private readonly isGloballyExpanded: () => boolean,
	) {}

	/** A change of the global ctrl+o state resets any local click toggle. */
	private syncWithGlobal(): void {
		const global = this.isGloballyExpanded()
		if (global === this.lastGlobalExpanded) return
		this.lastGlobalExpanded = global
		this.expanded = global
	}

	render(width: number): string[] {
		this.syncWithGlobal()
		const { summary, title, entries } = this.content()
		const left = this.expanded ? this.theme.fg("warning", title) : this.theme.fg("dim", summary)
		const hint = this.theme.fg("dim", `(ctrl+o to ${this.expanded ? "collapse" : "expand"})`)
		const lines = [buildAlignedLine(left, hint, width)]
		if (this.expanded) {
			for (const entry of entries) {
				for (const detail of entry.split("\n")) {
					lines.push(visibleWidth(detail) > width ? truncateToWidth(detail, width) : detail)
				}
			}
		}
		return lines
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined
		this.syncWithGlobal()
		this.expanded = !this.expanded
		return { handled: true }
	}

	invalidate(): void {}
}

/**
 * Transcript-message counterpart of {@link CollapsibleNotice}: the notice
 * persists in session history and scrolls with it, but keeps the
 * collapsed-by-default look of collapsed tool output. The TUI re-invokes the
 * renderer with the global ctrl+o state (`MessageRenderOptions.expanded`)
 * whenever it toggles, so expansion follows ctrl+o exactly like tool rows.
 *
 * Used for notices delivered via `pi.sendMessage({ customType, details })`
 * (MCP startup issues, relayed console warnings). The LLM only sees the
 * message `content` (a one-line system annotation); `details` never enters
 * the model context, so the entry list can grow without polluting it.
 */
export const noticeMessageRenderer: MessageRenderer<CollapsibleNoticeContent> = (message, options, theme) => {
	const data = message.details as CollapsibleNoticeContent | undefined
	if (!data) return undefined
	return new CollapsibleNotice(
		theme,
		() => data,
		() => options.expanded,
	)
}
