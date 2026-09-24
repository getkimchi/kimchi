/**
 * Presentation-layer relay for raw `console.warn` output from the upstream
 * `pi-mcp-adapter` and Kimchi's own MCP helpers (e.g. read-only.ts).
 *
 * Upstream MCP code warns via `console.warn` at unpredictable moments —
 * during adapter install, while resolving direct tools, and on every
 * planning-profile check. While the TUI owns the terminal in
 * alternate-screen mode, those bytes bypass the renderer and are drawn at
 * the current cursor position, clobbering the UI.
 *
 * This module patches `console.warn` once per process: messages that look
 * like MCP advisories (prefix match on `[mcp]`, `MCP:`, `Agent Plugin`)
 * are rerouted to `ctx.ui.notify` — message content is passed through
 * verbatim, nothing is reworded, aggregated, or re-deduped. Every other
 * `console.warn` call in the process continues to the original sink
 * untouched, and with no TUI (headless) MCP advisories pass through too.
 *
 * TODO(upstream): remove once pi-mcp-adapter exposes a logger callback so
 * warnings can be forwarded without patching console.warn.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

/** Prefixes that identify MCP-related advisory output worth rerouting. */
const MCP_WARN_PREFIX = /^(\[mcp\]|MCP:|Agent Plugin)/

function formatWarnArgs(args: unknown[]): string {
	return args.map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? arg.message : String(arg))).join(" ")
}

let latestUiCtx: ExtensionContext | undefined
let installedOriginal: typeof console.warn | undefined

/**
 * Update the UI context used for rerouted advisories. Call on every
 * session_start so resumed/switched sessions keep working.
 */
export function trackMcpWarnRelayContext(ctx: ExtensionContext): void {
	latestUiCtx = ctx
}

/**
 * Install the relay once. Idempotent: repeat calls keep the first
 * installation's original sink so stacking wrappers is impossible.
 */
export function installMcpWarnRelay(): void {
	if (installedOriginal) return
	installedOriginal = console.warn
	console.warn = (...args: unknown[]): void => {
		const ctx = latestUiCtx
		if (ctx?.hasUI && MCP_WARN_PREFIX.test(formatWarnArgs(args))) {
			ctx.ui.notify(formatWarnArgs(args), "warning")
			return
		}
		installedOriginal?.(...args)
	}
}

/** Test-only reset: restores the original console.warn and clears state. */
export function resetMcpWarnRelayForTests(): void {
	if (installedOriginal) {
		console.warn = installedOriginal
		installedOriginal = undefined
	}
	latestUiCtx = undefined
}
