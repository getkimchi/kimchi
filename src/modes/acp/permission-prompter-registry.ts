import type { ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"

const bySessionId = new Map<string, ToolPermissionPrompter>()

// Keep this paired with every ACP session ownership path: load/new register,
// bind failures, session/close, and process shutdown all need symmetric cleanup.
export function registerAcpPrompter(sessionId: string, prompter: ToolPermissionPrompter): void {
	bySessionId.set(sessionId, prompter)
}

/**
 * Id keys recycle across concurrent attaches (load+resume of one id coalesce
 * separately) and respawns, so a caller that registered a SPECIFIC prompter
 * passes it back for an identity check — deleting by key alone could evict
 * another (winning, still-live) session's prompter. Without `expected`, the
 * delete is unconditional (cleanup paths that own the id at that point).
 */
export function unregisterAcpPrompter(sessionId: string, expected?: ToolPermissionPrompter): void {
	if (expected !== undefined && bySessionId.get(sessionId) !== expected) return
	bySessionId.delete(sessionId)
}

export function getAcpPrompter(sessionId: string): ToolPermissionPrompter | undefined {
	return bySessionId.get(sessionId)
}
