/**
 * Transcript rows for relayed `console.warn` output.
 *
 * The console-warn relay reroutes process-wide warnings away from the raw
 * terminal in interactive mode. Rendering them via `ctx.ui.notify` would
 * stack one permanent `Warning:` chat line per warning (upstream
 * `showWarning` appends to the chat container); a pinned editor widget
 * would stay sticky for the whole session. Instead, warnings are printed
 * as collapsed transcript messages (see `noticeMessageRenderer`) — the
 * same one-dim-row look as collapsed tool output, expandable with ctrl+o,
 * scrolling away with history.
 *
 * Warnings fired in a burst (typical at startup) are aggregated: the
 * buffer flushes WARNING_AGGREGATE_WINDOW_MS after the FIRST warning, so
 * everything that co-occurs lands in one collapsed `[N warnings]` block
 * instead of N separate rows, while a steady warn stream still surfaces
 * promptly (throttled from the first warn, never reset, so a long boot
 * cannot defer visibility forever).
 *
 * Transcript entries are immutable, so "collapse first, expand later" is
 * delivered by the renderer (which the TUI re-invokes with the global
 * expand state), not by message mutation. The full warning text lives in
 * `details`; the LLM context only sees the one-line `<system-annotation>`
 * content per warning, so message size does not grow the token cost.
 *
 * Warnings are persisted in the session like any other transcript entry —
 * on resume they re-render from history even for a brand-new process.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { CollapsibleNoticeContent } from "../components/collapsible-notice.js"

/** Custom message type for a relayed console warning row. */
export const WARNINGS_SUMMARY_MESSAGE_TYPE = "kimchi-warnings-summary"

/**
 * Aggregation window: warnings buffered after a flush goes out together as
 * one `[N warnings]` block. Measured from the first buffered warning — the
 * timer is never reset by later arrivals.
 */
export const WARNING_AGGREGATE_WINDOW_MS = 1500

/**
 * State lives on globalThis, keyed by a well-known symbol: the bundled
 * binary duplicates this module into multiple chunks, and each duplicate
 * carries its own store — warnings recorded into one duplicate would be
 * invisible to the context tracked by another.
 */
type WarningsSummaryState = {
	latestCtx: ExtensionContext | undefined
	latestApi: ExtensionAPI | undefined
	pending: string[]
	timer: NodeJS.Timeout | undefined
}

const SUMMARY_STATE_KEY = Symbol.for("kimchi:warnings-summary:state")
const summaryGlobals = globalThis as Record<symbol, WarningsSummaryState>
summaryGlobals[SUMMARY_STATE_KEY] ??= {
	latestCtx: undefined,
	latestApi: undefined,
	pending: [],
	timer: undefined,
}
const state = summaryGlobals[SUMMARY_STATE_KEY]

/** Send whatever is buffered as one transcript block; no-op when empty. */
function flushPendingWarnings(): void {
	if (state.timer) {
		clearTimeout(state.timer)
		state.timer = undefined
	}
	const pending = state.pending.splice(0)
	if (pending.length === 0) return
	const ctx = state.latestCtx
	const pi = state.latestApi
	if (!ctx?.hasUI || !pi) {
		for (const message of pending) ctx?.ui.notify(message, "warning")
		return
	}
	const single = pending.length === 1
	const details: CollapsibleNoticeContent = {
		summary: single
			? `[Warning] ${pending[0].replace(/\s*\n\s*/g, " ")}`
			: `[${pending.length} warnings] Latest: ${pending[pending.length - 1].replace(/\s*\n\s*/g, " ")}`,
		title: single ? "[Warning]" : "[Warnings]",
		entries: pending,
	}
	pi.sendMessage(
		{
			customType: WARNINGS_SUMMARY_MESSAGE_TYPE,
			content: [
				{
					type: "text",
					text: single
						? "<system-annotation>Console warning relayed</system-annotation>"
						: `<system-annotation>Console warnings (${pending.length}) relayed</system-annotation>`,
				},
			],
			display: true,
			details,
		},
		{ triggerTurn: false },
	)
}

/**
 * Track the active session's context and API. Call on every session_start
 * so resumed/switched sessions keep routing warnings into the right session.
 * Anything still buffered is flushed into the previous session first.
 */
export function trackWarningsSummaryContext(ctx: ExtensionContext, pi?: ExtensionAPI): void {
	flushPendingWarnings()
	state.latestCtx = ctx
	state.latestApi = pi
}

/**
 * Record one deduped warning from the console-warn relay: buffered and
 * flushed as one collapsed transcript block after the aggregation window.
 * Falls back to `ctx.ui.notify` when the tracked context has no UI.
 */
export function recordRelayedWarning(message: string): void {
	const ctx = state.latestCtx
	const pi = state.latestApi
	if (!ctx?.hasUI || !pi) {
		ctx?.ui.notify(message, "warning")
		return
	}
	state.pending.push(message)
	// Timer is set once per window (throttle by first arrival, not debounce)
	// so a continuous warn stream flushes every window instead of being
	// deferred forever. unref so the buffer never delays process exit.
	state.timer ??= setTimeout(flushPendingWarnings, WARNING_AGGREGATE_WINDOW_MS)
	state.timer.unref()
}

/** Test-only reset: clears tracked context/API state and pending buffer. */
export function resetWarningsSummaryForTests(): void {
	if (state.timer) {
		clearTimeout(state.timer)
		state.timer = undefined
	}
	state.pending.length = 0
	state.latestCtx = undefined
	state.latestApi = undefined
}
