/**
 * Collapsed-by-default widget for relayed `console.warn` output.
 *
 * The console-warn relay reroutes process-wide warnings away from the raw
 * terminal in interactive mode. Rendering them via `ctx.ui.notify` would
 * stack one permanent `Warning:` chat line per warning (upstream
 * `showWarning` appends to the chat container). Instead, warnings
 * accumulate in a single notice above the editor, collapsed by default —
 * one dim `[N warnings] Latest: …` row, expanded by ctrl+o or a click (see
 * `CollapsibleNotice`).
 *
 * The notice is a UI-only widget, not a transcript message: warnings never
 * reach the LLM context or session history, so they cannot alter the
 * conversation or compaction. The flip side is that they are per-process
 * UI state — each tracked session starts with an empty notice.
 *
 * Buffer is capped at 50 entries; oldest are dropped and summarized as a
 * "… (K earlier warnings not shown)" line so a warning loop cannot grow
 * the expanded view without bound. The count uses the uncapped total.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { CollapsibleNotice, type CollapsibleNoticeContent } from "../components/collapsible-notice.js"

/** Widget key for the warnings notice. */
export const WARNINGS_WIDGET_KEY = "kimchi-warnings-summary"

/** Upper bound on buffered entries; overflow is summarized, not listed. */
const MAX_ENTRIES = 50

/**
 * State lives on globalThis, keyed by a well-known symbol: the bundled
 * binary duplicates this module into multiple chunks, and each duplicate
 * carries its own store — warnings recorded into one duplicate would be
 * invisible to the widget installed by another.
 */
type WarningsSummaryState = {
	latestCtx: ExtensionContext | undefined
	/** TUI of the mounted widget; undefined until the first warning mounts it. */
	tui: TUI | undefined
	store: string[]
	/** Uncapped number of warnings recorded this session. */
	totalCount: number
}

const SUMMARY_STATE_KEY = Symbol.for("kimchi:warnings-summary:state")
const summaryGlobals = globalThis as Record<symbol, WarningsSummaryState>
summaryGlobals[SUMMARY_STATE_KEY] ??= {
	latestCtx: undefined,
	tui: undefined,
	store: [],
	totalCount: 0,
}
const state = summaryGlobals[SUMMARY_STATE_KEY]

function warningsNoun(count: number): string {
	return `warning${count === 1 ? "" : "s"}`
}

function noticeContent(): CollapsibleNoticeContent {
	const count = state.totalCount
	const latest = state.store[state.store.length - 1]?.replace(/\s*\n\s*/g, " ") ?? ""
	const overflow = count - state.store.length
	return {
		summary: `[${count} ${warningsNoun(count)}] Latest: ${latest}`,
		title: "[Warnings]",
		entries:
			overflow > 0 ? [`… (${overflow} earlier ${warningsNoun(overflow)} not shown)`, ...state.store] : state.store,
	}
}

/**
 * Update the context used for the widget and clear session state.
 * Call on every session_start so resumed/switched sessions start fresh.
 */
export function trackWarningsSummaryContext(ctx: ExtensionContext): void {
	state.latestCtx = ctx
	state.tui = undefined
	state.store = []
	state.totalCount = 0
	if (ctx.hasUI) ctx.ui.setWidget(WARNINGS_WIDGET_KEY, undefined)
}

/**
 * Record one deduped warning from the console-warn relay. Falls back to
 * `ctx.ui.notify` when the tracked context has no UI.
 */
export function recordRelayedWarning(message: string): void {
	const ctx = state.latestCtx
	if (!ctx?.hasUI) {
		ctx?.ui.notify(message, "warning")
		return
	}
	state.store.push(message)
	state.totalCount += 1
	if (state.store.length > MAX_ENTRIES) state.store.shift()
	if (state.tui) {
		state.tui.requestRender()
		return
	}
	ctx.ui.setWidget(WARNINGS_WIDGET_KEY, (tui, theme) => {
		state.tui = tui
		return new CollapsibleNotice(theme, noticeContent, () => ctx.ui.getToolsExpanded())
	})
}

/** Test-only reset: clears tracked context and store state. */
export function resetWarningsSummaryForTests(): void {
	state.latestCtx = undefined
	state.tui = undefined
	state.store = []
	state.totalCount = 0
}
