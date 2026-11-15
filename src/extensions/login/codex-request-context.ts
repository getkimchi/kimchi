import { v7 as uuidv7 } from "uuid"

export type CodexRequestKind = "turn" | "compaction"

export interface CodexRequestMetadata {
	sessionId: string
	threadId: string
	turnId: string
	requestKind: CodexRequestKind
	windowId: string
	windowNumber: number
}

interface SessionState {
	turnId: string
	windowNumber: number
	compacting: boolean
}

const sessions = new Map<string, SessionState>()

function stateFor(sessionId: string): SessionState {
	let state = sessions.get(sessionId)
	if (!state) {
		state = { turnId: uuidv7(), windowNumber: 0, compacting: false }
		sessions.set(sessionId, state)
	}
	return state
}

export function startCodexTurn(sessionId: string, windowNumber: number): void {
	sessions.set(sessionId, { turnId: uuidv7(), windowNumber, compacting: false })
}

export function beginCodexCompaction(sessionId: string): void {
	stateFor(sessionId).compacting = true
}

export function endCodexCompaction(sessionId: string, windowNumber: number): void {
	const state = stateFor(sessionId)
	state.compacting = false
	state.windowNumber = windowNumber
}

export function resetCodexSession(sessionId: string): void {
	sessions.delete(sessionId)
}

/**
 * The session whose correlation a request should carry. pi's compaction and
 * branch summaries send a random session id, so an unknown id maps to the one
 * session that is compacting; any other unknown id maps to nothing.
 */
export function resolveCodexSession(requestSessionId: string | undefined): string | undefined {
	if (requestSessionId && sessions.has(requestSessionId)) return requestSessionId
	const compacting = [...sessions].filter(([, state]) => state.compacting)
	return compacting.length === 1 ? compacting[0][0] : undefined
}

/** Never records state: an unknown id reads as a fresh session at window 0. */
export function codexRequestMetadata(sessionId: string): CodexRequestMetadata {
	const state = sessions.get(sessionId) ?? { turnId: uuidv7(), windowNumber: 0, compacting: false }
	return {
		sessionId,
		threadId: sessionId,
		turnId: state.turnId,
		requestKind: state.compacting ? "compaction" : "turn",
		windowId: `${sessionId}:${state.windowNumber}`,
		windowNumber: state.windowNumber,
	}
}

export function countCompactions(entries: readonly { type: string }[]): number {
	return entries.filter((e) => e.type === "compaction").length
}
