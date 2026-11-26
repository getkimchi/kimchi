import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getSideChatHost } from "../../side-chat/harness.js"
import type { TelemetryContext } from "../session-context.js"

/**
 * Snapshot of the interactive TUI mode at session_start. Read from the
 * authoritative live renderer via the always-loaded side-chat harness
 * (`isViewportTUI(mode.renderer)`), not from a mutable setting or argv.
 *
 * Omitted (undefined) for non-TUI run modes (rpc / json / print — the ACP host
 * among them) and when the live interactive session is unavailable, rather
 * than guessing `regular`.
 */
export function resolveTuiStartupMode(ctx: ExtensionContext): "fullscreen" | "regular" | undefined {
	if (ctx.mode !== "tui") return undefined
	const host = getSideChatHost()
	if (!host) return undefined
	return host.isFullscreen() ? "fullscreen" : "regular"
}

export function handleSessionStart(tm: TelemetryContext, ctx: ExtensionContext): void {
	tm.reset()
	// Capture the startup mode from the live renderer now, at session_start —
	// before any later fullscreen/regular switch can change it. reset() cleared
	// the previous session's snapshot; this is the only place it is written.
	tm.tuiStartupMode = resolveTuiStartupMode(ctx)
	const sessionId = ctx.sessionManager.getSessionId()
	if (sessionId) tm.setPiSessionId(sessionId)
	if (ctx.model?.id) tm.currentModel = ctx.model.id
	tm.startFlushTimer()
}

export function emitSessionStartEvent(tm: TelemetryContext, ctx: ExtensionContext): void {
	// tui_startup_mode carries the session_start snapshot (omitted for non-TUI
	// sessions and when the renderer could not be resolved), never a later mode.
	tm.emit("session.start", tm.tuiStartupMode === undefined ? {} : { tui_startup_mode: tm.tuiStartupMode }, ctx)
}

export async function handleSessionShutdown(
	tm: TelemetryContext,
	ctx: ExtensionContext,
	event: { reason?: string },
): Promise<void> {
	tm.emit(
		"session.end",
		{
			duration_ms: Date.now() - tm.telemetryStartMs,
			ended_by: event?.reason ?? "unknown",
			compaction_count: tm.compactionCount,
			turn_index: tm.turnIndex,
		},
		ctx,
	)
	tm.flushLogBuffer()
	await tm.drain()
}

export function handleSessionCompact(tm: TelemetryContext, ctx: ExtensionContext): void {
	tm.compactionCount++
	tm.emit(
		"session.compacted",
		{
			compaction_count: tm.compactionCount,
			turn_index: tm.turnIndex,
		},
		ctx,
	)
}
