import type { ToolPermissionPrompter } from "../../extensions/permissions/prompter.js"

const bySessionId = new Map<string, ToolPermissionPrompter>()

// Keep this paired with every ACP session ownership path. Any future
// closeSession/releaseSession RPC that removes from KimchiAcpAgent.sessions
// must call unregisterAcpPrompter for the same sessionId.
export function registerAcpPrompter(sessionId: string, prompter: ToolPermissionPrompter): void {
	bySessionId.set(sessionId, prompter)
}

export function unregisterAcpPrompter(sessionId: string): void {
	bySessionId.delete(sessionId)
}

export function getAcpPrompter(sessionId: string): ToolPermissionPrompter | undefined {
	return bySessionId.get(sessionId)
}
