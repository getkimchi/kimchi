/**
 * Collapsed-by-default transcript row for relayed `console.warn` output.
 *
 * The console-warn relay reroutes process-wide warnings away from the raw
 * terminal in interactive mode. Rendering them via `ctx.ui.notify` would
 * stack one permanent `Warning:` chat line per warning (upstream
 * `showWarning` appends to the chat container). Instead, warnings
 * accumulate in a single custom transcript entry rendered collapsed by
 * default — one dim `[N warnings] Latest: …` row with a right-aligned
 * "(ctrl+o to expand)" hint, mirroring the MCP startup-issues row and the
 * collapsed tool-row convention. Click toggles only this row; ctrl+o
 * toggles it together with tool output via the global `setToolsExpanded()`
 * pass (the host re-invokes the renderer with the new `expanded` flag).
 *
 * The row is a custom transcript message with empty content and
 * `display: true` (UI-only, no LLM turn, no prompt tokens — the same
 * channel as the MCP startup-issues row), sent once per session on the
 * first warning; startup delivery is proven by the startup-issues flow,
 * which renders during session_start where a raw `appendEntry` would land
 * before the chat subscription exists. The component reads the live
 * module store, so later warnings update the count on the next natural
 * render. A footer status (`N warnings`) keeps the count exact even when
 * the UI is idle and the row's repaint lags, and forces a render on
 * every update.
 *
 * On session replay (resume/reload/fork) the persisted entry re-renders
 * from its creation-time snapshot until the first new warning repopulates
 * the live store.
 *
 * Buffer is capped at 50 entries; oldest are dropped and summarized as a
 * "… (K earlier warnings not shown)" line so a warning loop cannot grow
 * the expanded view without bound.
 */

import type { ExtensionAPI, ExtensionContext, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent"
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui"
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui"
import { buildAlignedLine } from "../components/tool-block.js"

/** Custom entry type carrying the collapsed console warnings row. */
export const WARNINGS_ENTRY_TYPE = "kimchi-warnings-summary"

/** Footer status key for the live warnings counter. */
const WARNINGS_STATUS_KEY = "warnings"

/** Upper bound on buffered entries; overflow is summarized, not listed. */
const MAX_ENTRIES = 50

interface WarningsEntryData {
	entries: string[]
}

/**
 * State lives on globalThis, keyed by a well-known symbol: the bundled
 * binary duplicates this module into multiple chunks, and each duplicate
 * carries its own store — warnings recorded into one duplicate would be
 * invisible to the renderer installed by another.
 */
type WarningsSummaryState = {
	capturedPi: ExtensionAPI | undefined
	latestCtx: ExtensionContext | undefined
	store: string[]
	overflowCount: number
	messageSent: boolean
}

const SUMMARY_STATE_KEY = Symbol.for("kimchi:warnings-summary:state")
const summaryGlobals = globalThis as Record<symbol, WarningsSummaryState>
summaryGlobals[SUMMARY_STATE_KEY] ??= {
	capturedPi: undefined,
	latestCtx: undefined,
	store: [],
	overflowCount: 0,
	messageSent: false,
}
const state = summaryGlobals[SUMMARY_STATE_KEY]

class WarningsLine implements Component {
	constructor(
		private readonly theme: Theme,
		private readonly persistedEntries: readonly string[],
		private expanded: boolean,
	) {}

	/** Live store wins; persisted snapshot only matters on session replay. */
	private activeEntries(): readonly string[] {
		return state.store.length > 0 ? state.store : this.persistedEntries
	}

	render(width: number): string[] {
		const entries = this.activeEntries()
		const count = entries.length
		const noun = `warning${count === 1 ? "" : "s"}`
		const latest = entries[entries.length - 1]?.replace(/\s*\n\s*/g, " ") ?? ""
		const left = this.expanded
			? this.theme.fg("warning", "[Warnings]")
			: this.theme.fg("dim", `[${count} ${noun}] Latest: ${latest}`)
		const hint = this.theme.fg("dim", `(ctrl+o to ${this.expanded ? "collapse" : "expand"})`)
		const lines = [buildAlignedLine(left, hint, width)]
		if (this.expanded) {
			if (state.overflowCount > 0 && state.store.length > 0) {
				lines.push(
					this.theme.fg(
						"dim",
						`… (${state.overflowCount} earlier warning${state.overflowCount === 1 ? "" : "s"} not shown)`,
					),
				)
			}
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
		this.expanded = !this.expanded
		return { handled: true }
	}

	invalidate(): void {}
}

/**
 * Renderer for the collapsed warnings row. `options.expanded` reflects the
 * global ctrl+o state at render time; the host re-invokes the renderer
 * whenever it changes, so local click state is always reset by a global
 * toggle — same semantics as the startup-issues row.
 */
export const warningsMessageRenderer: MessageRenderer<WarningsEntryData> = (message, options, theme) => {
	const persisted = message.details?.entries ?? []
	if (persisted.length === 0 && state.store.length === 0) return undefined
	return new WarningsLine(theme, persisted, options.expanded)
}

/**
 * Register the message renderer and capture `pi` for sending the row.
 * Idempotent: repeat installs do not stack renderers.
 */
export function installWarningsSummary(pi: ExtensionAPI): void {
	if (state.capturedPi) return
	state.capturedPi = pi
	pi.registerMessageRenderer(WARNINGS_ENTRY_TYPE, warningsMessageRenderer)
}

/**
 * Update the context used for the footer counter and clear session state.
 * Call on every session_start so resumed/switched sessions start fresh.
 */
export function trackWarningsSummaryContext(ctx: ExtensionContext): void {
	state.latestCtx = ctx
	state.store = []
	state.overflowCount = 0
	state.messageSent = false
	if (ctx.hasUI) ctx.ui.setStatus(WARNINGS_STATUS_KEY, undefined)
}

/**
 * Record one deduped warning from the console-warn relay. Falls back to
 * `ctx.ui.notify` when the summary module is not installed or the tracked
 * context has no UI, preserving the relay's behavior for other entry
 * points and headless-adjacent paths.
 */
export function recordRelayedWarning(message: string): void {
	const ctx = state.latestCtx
	const pi = state.capturedPi
	if (!pi || !ctx?.hasUI) {
		ctx?.ui.notify(message, "warning")
		return
	}
	state.store.push(message)
	if (state.store.length > MAX_ENTRIES) {
		state.store.shift()
		state.overflowCount += 1
	}
	if (!state.messageSent) {
		pi.sendMessage<WarningsEntryData>(
			{
				customType: WARNINGS_ENTRY_TYPE,
				content: "",
				display: true,
				details: { entries: [...state.store] },
			},
			{ triggerTurn: false },
		)
		state.messageSent = true
	}
	ctx.ui.setStatus(WARNINGS_STATUS_KEY, `${state.store.length} warning${state.store.length === 1 ? "" : "s"}`)
}

/** Test-only reset: clears captured pi, tracked context, and store state. */
export function resetWarningsSummaryForTests(): void {
	state.capturedPi = undefined
	state.latestCtx = undefined
	state.store = []
	state.overflowCount = 0
	state.messageSent = false
}
