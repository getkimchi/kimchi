import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
	beginCodexCompaction,
	countCompactions,
	endCodexCompaction,
	resetCodexSession,
	startCodexTurn,
} from "./codex-request-context.js"

/**
 * Feeds the per-session Codex correlation state (see codex-request-context.ts) from pi session events.
 * Standalone so every session that can send Codex gateway requests loads it (main and each subagent,
 * each its own thread) without pulling in the login extension. The window number is the compaction
 * count on the current branch, so resume and /tree switches land on the right window.
 */
export default function codexCorrelationExtension(pi: ExtensionAPI): void {
	const sessionOf = (ctx: ExtensionContext) => ({
		id: ctx.sessionManager.getSessionId(),
		windows: countCompactions(ctx.sessionManager.getBranch()),
	})
	pi.on("before_agent_start", (_event, ctx) => {
		const { id, windows } = sessionOf(ctx)
		startCodexTurn(id, windows)
	})
	pi.on("session_before_compact", (_event, ctx) => {
		beginCodexCompaction(ctx.sessionManager.getSessionId())
	})
	const endCompaction = (_event: unknown, ctx: ExtensionContext) => {
		const { id, windows } = sessionOf(ctx)
		endCodexCompaction(id, windows)
	}
	pi.on("session_compact", endCompaction)
	pi.on("session_compact_failed", endCompaction)
	pi.on("session_shutdown", (_event, ctx) => {
		resetCodexSession(ctx.sessionManager.getSessionId())
	})
}
