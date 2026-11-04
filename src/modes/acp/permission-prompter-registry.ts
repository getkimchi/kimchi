// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import type { ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"

const bySessionId = new Map<string, ToolPermissionPrompter>()

// Keep this paired with every ACP session ownership path: load/new register,
// bind failures, session/close, and process shutdown all need symmetric cleanup.
export function registerAcpPrompter(sessionId: string, prompter: ToolPermissionPrompter): void {
	bySessionId.set(sessionId, prompter)
}

export function unregisterAcpPrompter(sessionId: string): void {
	bySessionId.delete(sessionId)
}

export function getAcpPrompter(sessionId: string): ToolPermissionPrompter | undefined {
	return bySessionId.get(sessionId)
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
