import { toAttrs } from "../helpers.js"
import type { SessionContext } from "../session-context.js"
import { getSessionType } from "../session-type.js"
import { sendLog } from "../transport.js"

export function handleSessionInitialized(ctx: SessionContext, initialModel?: string): void {
	ctx.reset(ctx.source)
	if (initialModel) ctx.currentModel = initialModel
	ctx.startFlushTimer()
}

export function emitSessionStartEvent(ctx: SessionContext): void {
	ctx.emit("session.start", { model: ctx.currentModel })
}

export async function handleSessionShutdown(ctx: SessionContext, event: { reason?: string }): Promise<void> {
	ctx.flushLogBuffer()
	const endedBy = event?.reason ?? "unknown"
	await ctx.userEmailReady
	await sendLog(
		ctx.config,
		ctx.sessionId,
		"session.end",
		toAttrs({
			model: ctx.currentModel,
			duration_ms: Date.now() - ctx.sessionStartMs,
			ended_by: endedBy,
			source: ctx.source,
			session_type: getSessionType(),
		}),
		ctx.userEmail,
	)
	await ctx.drain()
}
