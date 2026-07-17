import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { TelemetryContext } from "../session-context.js"

export function handleSessionStart(telemetry: TelemetryContext, ctx: ExtensionContext): void {
	telemetry.reset()
	if (ctx.model?.id) telemetry.currentModel = ctx.model.id
	telemetry.startFlushTimer()
}

export function emitSessionStartEvent(telemetry: TelemetryContext, ctx: ExtensionContext): void {
	telemetry.emit("session.start", {}, ctx)
}

export async function handleSessionShutdown(
	telemetry: TelemetryContext,
	ctx: ExtensionContext,
	event: { reason?: string },
): Promise<void> {
	telemetry.emit(
		"session.end",
		{
			duration_ms: Date.now() - telemetry.processStartMs,
			ended_by: event?.reason ?? "unknown",
			compaction_count: telemetry.compactionCount,
			turn_index: telemetry.turnIndex,
		},
		ctx,
	)
	telemetry.flushLogBuffer()
	await telemetry.drain()
}

export function handleSessionCompact(telemetry: TelemetryContext, ctx: ExtensionContext): void {
	telemetry.compactionCount++
	telemetry.emit(
		"session.compacted",
		{
			compaction_count: telemetry.compactionCount,
			turn_index: telemetry.turnIndex,
		},
		ctx,
	)
}
