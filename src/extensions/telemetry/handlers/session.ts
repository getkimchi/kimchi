import type { SessionContext } from "../session-context.js"

export function handleSessionInitialized(ctx: SessionContext, initialModel?: string): void {
	ctx.reset(ctx.source)
	if (initialModel) ctx.currentModel = initialModel
	ctx.startFlushTimer()
}

export function emitSessionStartEvent(ctx: SessionContext): void {
	ctx.emit("session.start", { model: ctx.currentModel })
}

export async function handleSessionShutdown(ctx: SessionContext, event: { reason?: string }): Promise<void> {
	const endedBy = event?.reason ?? "unknown"
	ctx.emit("session.end", {
		model: ctx.currentModel,
		duration_ms: Date.now() - ctx.sessionStartMs,
		ended_by: endedBy,
	})
	ctx.flushLogBuffer()
	await ctx.drain()
}
