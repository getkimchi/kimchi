import { getActiveFerment } from "../../ferment/index.js"
import { toAttrs } from "../helpers.js"
import type { SessionContext } from "../session-context.js"
import { sendLog } from "../transport.js"

export function handleSessionStart(ctx: SessionContext, initialModel?: string): void {
	const mode = getActiveFerment() ? "ferment" : "coding"
	ctx.reset(ctx.source, mode)
	if (initialModel) ctx.currentModel = initialModel
	ctx.startFlushTimer()
	ctx.emit("session.start", { model: ctx.currentModel })
}

export async function handleSessionShutdown(ctx: SessionContext, event: { reason?: string }): Promise<void> {
	ctx.flushLogBuffer()
	const endedBy = event?.reason ?? "unknown"
	await sendLog(
		ctx.config,
		ctx.sessionId,
		"session.end",
		toAttrs({
			model: ctx.currentModel,
			duration_ms: Date.now() - ctx.sessionStartMs,
			ended_by: endedBy,
			source: ctx.source,
			mode: ctx.mode,
		}),
	)
	await ctx.drain()
}
