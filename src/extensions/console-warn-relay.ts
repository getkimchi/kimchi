/**
 * Presentation-layer relay for raw `console.warn` output in interactive
 * (TUI) sessions.
 *
 * pi-tui performs no output interception: any raw `console.warn` bytes —
 * from upstream `@earendil-works/pi-coding-agent`, `pi-mcp-adapter`,
 * Kimchi's own extensions, or any dependency — are written straight to the
 * terminal, bypassing the diff renderer and clobbering the prompt editor
 * and surrounding UI. This module patches `console.warn` once per process
 * so that in interactive mode every warning is rerouted to the
 * collapsed-by-default warnings-summary notice above the editor (see
 * `warnings-summary.ts`) instead of terminal bytes. The summary module
 * falls back to `ctx.ui.notify` when the tracked context has no UI.
 *
 * Behavior:
 * - Interactive (tracked context with `hasUI`): the arguments are formatted
 *   with `util.format` (same output the terminal would have shown) and all
 *   terminal control sequences (CSI colors, OSC hyperlinks/titles) are
 *   stripped (upstream code warns with `chalk`, and
 *   `showWarning` applies its own theme color — foreign escapes must not
 *   nest), then identical messages within a 10s window are deduped so
 *   repeated warnings don't stack identical entries. Non-duplicate
 *   messages are forwarded to the warnings-summary store and the original
 *   sink is left alone. If recording throws, the warn falls back to the
 *   original sink — a patched `console.warn` must never throw into callers.
 * - Headless (no tracked context or `hasUI` false): the original sink
 *   receives the original arguments verbatim — no dedupe, no formatting,
 *   no ANSI stripping.
 *
 * Wiring: the default export is a standalone extension registered first in
 * `cli.ts`, so the relay covers every extension and dependency regardless of
 * which optional extensions (e.g. MCP) are enabled.
 *
 * State lives on globalThis, keyed by a well-known symbol: the bundled
 * binary duplicates this module into multiple chunks, and a module-local
 * "already installed" guard lets every duplicate wrap the previous
 * duplicate's patched console.warn — each layer would then route the same
 * warn again (observed symptom: one console.warn recorded 5 times in the
 * warnings row of the real binary while unit tests saw one).
 *
 * TODO(upstream): remove once pi-mono exposes a logger/warn callback so
 * warnings can be forwarded without patching console.warn. Tracked by
 * https://github.com/earendil-works/pi/issues/10002 — "Extension console
 * output writes over the interactive TUI" (includes a pi-mcp-adapter
 * reproduction). Re-check on every pi dependency upgrade; when upstream
 * intercepts or reroutes extension console output, drop this relay.
 */

import { format, stripVTControlCharacters } from "node:util"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { recordRelayedWarning, trackWarningsSummaryContext } from "./warnings-summary.js"

/** Identical messages within this window are swallowed in interactive mode. */
const DEDUPE_WINDOW_MS = 10_000

/** Upper bound on tracked messages; exceeded → the map is cleared. */
const DEDUPE_MAP_MAX = 256

/** Upper bound on pre-track queued warns; overflow drains oldest to the sink. */
const PENDING_PRE_TRACK_MAX = 20

type RelayState = {
	installedOriginal: typeof console.warn | undefined
	latestUiCtx: ExtensionContext | undefined
	recentWarns: Map<string, number>
	pendingPreTrack: unknown[][]
	hasTrackedCtx: boolean
	/** Flushes never-drained pre-track warns on exit; kept for test cleanup. */
	exitListener: (() => void) | undefined
}

const RELAY_STATE_KEY = Symbol.for("kimchi:console-warn-relay:state")
const relayGlobals = globalThis as Record<symbol, RelayState>
relayGlobals[RELAY_STATE_KEY] ??= {
	installedOriginal: undefined,
	latestUiCtx: undefined,
	recentWarns: new Map(),
	pendingPreTrack: [],
	hasTrackedCtx: false,
	exitListener: undefined,
}
const state = relayGlobals[RELAY_STATE_KEY]

/**
 * Interactive route: format, strip control sequences, dedupe identical
 * messages in the window, record. Any failure falls back to the original
 * sink so callers of `console.warn` never see a throw.
 */
function routeInteractive(args: unknown[]): void {
	try {
		const message = stripVTControlCharacters(format(...args))
		const now = Date.now()
		const seenAt = state.recentWarns.get(message)
		if (seenAt !== undefined && now - seenAt < DEDUPE_WINDOW_MS) return
		if (state.recentWarns.size >= DEDUPE_MAP_MAX) state.recentWarns.clear()
		state.recentWarns.set(message, now)
		recordRelayedWarning(message)
	} catch {
		state.installedOriginal?.(...args)
	}
}

/**
 * Update the UI context used for rerouted warnings. Call on every
 * session_start so resumed/switched sessions keep working. Each new
 * tracked context also clears the dedupe state, treating the session
 * boundary as a fresh start.
 *
 * Warnings that fired before the first track (e.g. from another
 * extension's session_start handler that ran ahead of ours) are drained
 * here: relayed into the warnings row when the session is interactive,
 * or passed to the original sink verbatim when headless.
 */
export function trackConsoleWarnRelayContext(ctx: ExtensionContext): void {
	state.latestUiCtx = ctx
	state.recentWarns.clear()
	if (state.pendingPreTrack.length > 0) {
		const queued = state.pendingPreTrack.splice(0)
		if (ctx.hasUI) {
			for (const args of queued) routeInteractive(args)
		} else {
			for (const args of queued) state.installedOriginal?.(...args)
		}
	}
	state.hasTrackedCtx = true
}

/**
 * Install the relay once. Idempotent: repeat calls keep the first
 * installation's original sink so stacking wrappers is impossible, even
 * across duplicated module instances in the bundled binary.
 */
export function installConsoleWarnRelay(): void {
	if (state.installedOriginal) return
	state.installedOriginal = console.warn
	// A process that exits before any session_start (auth/setup failure,
	// early exit) would otherwise drop queued warns silently.
	state.exitListener = () => {
		for (const args of state.pendingPreTrack.splice(0)) state.installedOriginal?.(...args)
	}
	process.on("exit", state.exitListener)
	console.warn = (...args: unknown[]): void => {
		const ctx = state.latestUiCtx
		if (ctx?.hasUI) {
			routeInteractive(args)
			return
		}
		if (!state.hasTrackedCtx) {
			// Pre-track: no way to know the session mode yet. Queue instead of
			// writing raw bytes — on a TUI startup these would bypass the diff
			// renderer before the first context is tracked. Bound the queue so a
			// headless firehose still reaches stderr in order.
			state.pendingPreTrack.push(args)
			if (state.pendingPreTrack.length > PENDING_PRE_TRACK_MAX) {
				const overflow = state.pendingPreTrack.shift()
				if (overflow) state.installedOriginal?.(...overflow)
			}
			return
		}
		state.installedOriginal?.(...args)
	}
}

/** Test-only reset: restores the original console.warn and clears all state. */
export function resetConsoleWarnRelayForTests(): void {
	if (state.installedOriginal) {
		console.warn = state.installedOriginal
		state.installedOriginal = undefined
	}
	if (state.exitListener) {
		process.off("exit", state.exitListener)
		state.exitListener = undefined
	}
	state.latestUiCtx = undefined
	state.recentWarns.clear()
	state.pendingPreTrack.length = 0
	state.hasTrackedCtx = false
}

/**
 * Installs the relay at load time and tracks every session's context.
 * Summary context first: tracking the relay drains pre-track queued warns
 * into recordRelayedWarning, which needs the summary's ctx.
 */
export default function consoleWarnRelayExtension(pi: ExtensionAPI): void {
	installConsoleWarnRelay()
	pi.on("session_start", (_event, ctx) => {
		trackWarningsSummaryContext(ctx)
		trackConsoleWarnRelayContext(ctx)
	})
}
