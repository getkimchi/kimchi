import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TelemetryContext } from "../session-context.js"

export function handleSessionStart(tm: TelemetryContext, ctx: ExtensionContext): void {
	tm.reset()
	if (ctx.model?.id) tm.currentModel = ctx.model.id
	tm.startFlushTimer()
}

export function emitSessionStartEvent(tm: TelemetryContext, ctx: ExtensionContext): void {
	tm.emit("session.start", {}, ctx)
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
