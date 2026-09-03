import type { PromptMode } from "./prompt-construction/system-prompt.js"

// Lives for the process lifetime; each entry holds one short mode string.
const modeBySession = new Map<string, PromptMode>()

export function setSessionMode(sessionId: string | undefined, mode: PromptMode): void {
	if (!sessionId) return
	modeBySession.set(sessionId, mode)
}

export function getSessionMode(sessionId: string | undefined): PromptMode | undefined {
	return sessionId ? modeBySession.get(sessionId) : undefined
}
