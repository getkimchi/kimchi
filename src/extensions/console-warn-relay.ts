/**
 * Presentation-layer relay for raw `console.warn` output in interactive
 * (TUI) sessions.
 *
 * pi-tui performs no output interception: any raw `console.warn` bytes —
 * from upstream `@earendil-works/pi-coding-agent`, `pi-mcp-adapter`,
 * Kimchi's own extensions, or any dependency — are written straight to the
 * terminal, bypassing the diff renderer and clobbering the prompt editor
 * and surrounding UI. This module patches `console.warn` once per process
 * so that in interactive mode every warning becomes a display-only
 * `Warning:` chat line via `ctx.ui.notify` instead of terminal bytes.
 *
 * Behavior:
 * - Interactive (tracked context with `hasUI`): the formatted message has
 *   ANSI escape codes stripped (upstream code warns with `chalk`, and
 *   `showWarning` applies its own theme color — foreign escapes must not
 *   nest), then identical messages within a 10s window are deduped so
 *   repeated warnings don't stack identical chat lines. Non-duplicate
 *   messages are forwarded to `ctx.ui.notify(message, "warning")` and the
 *   original sink is left alone.
 * - Headless (no tracked context or `hasUI` false): the original sink
 *   receives the original arguments verbatim — no dedupe, no formatting,
 *   no ANSI stripping.
 *
 * TODO(upstream): remove once pi-mono exposes a logger/warn callback so
 * warnings can be forwarded without patching console.warn.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

/** ANSI CSI escape sequences (e.g. `\u001b[33m` colors from `chalk`). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESC (0x1b) introduces the CSI sequences being stripped
const ANSI_CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g

/** Identical messages within this window are swallowed in interactive mode. */
const DEDUPE_WINDOW_MS = 10_000

/** Upper bound on tracked messages; exceeded → the map is cleared. */
const DEDUPE_MAP_MAX = 256

function formatWarnArgs(args: unknown[]): string {
	return args.map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? arg.message : String(arg))).join(" ")
}

let latestUiCtx: ExtensionContext | undefined
let installedOriginal: typeof console.warn | undefined
const recentWarns = new Map<string, number>()

/**
 * Update the UI context used for rerouted warnings. Call on every
 * session_start so resumed/switched sessions keep working. Each new
 * tracked context also clears the dedupe state, treating the session
 * boundary as a fresh start.
 */
export function trackConsoleWarnRelayContext(ctx: ExtensionContext): void {
	latestUiCtx = ctx
	recentWarns.clear()
}

/**
 * Install the relay once. Idempotent: repeat calls keep the first
 * installation's original sink so stacking wrappers is impossible.
 */
export function installConsoleWarnRelay(): void {
	if (installedOriginal) return
	installedOriginal = console.warn
	console.warn = (...args: unknown[]): void => {
		const ctx = latestUiCtx
		if (!ctx?.hasUI) {
			installedOriginal?.(...args)
			return
		}
		const message = formatWarnArgs(args).replace(ANSI_CSI_PATTERN, "")
		const now = Date.now()
		const seenAt = recentWarns.get(message)
		if (seenAt !== undefined && now - seenAt < DEDUPE_WINDOW_MS) return
		if (recentWarns.size >= DEDUPE_MAP_MAX) recentWarns.clear()
		recentWarns.set(message, now)
		ctx.ui.notify(message, "warning")
	}
}

/** Test-only reset: restores the original console.warn and clears all state. */
export function resetConsoleWarnRelayForTests(): void {
	if (installedOriginal) {
		console.warn = installedOriginal
		installedOriginal = undefined
	}
	latestUiCtx = undefined
	recentWarns.clear()
}
