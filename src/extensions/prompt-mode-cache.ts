import type { PromptMode } from "./prompt-construction/system-prompt.js"

// The mode the last system prompt was built with, per session. Reading the
// multi-model flag again later can disagree with it: the flag is toggleable
// mid-session, and on the first prompt of a session no prompt has been built
// yet. Anything that has to match the mode section the model is actually
// reading needs this recorded value, not a fresh read.
const modeBySession = new Map<string, PromptMode>()

export function setPromptMode(sessionId: string | undefined, mode: PromptMode): void {
	if (!sessionId) return
	modeBySession.set(sessionId, mode)
}

export function getPromptMode(sessionId: string | undefined): PromptMode | undefined {
	return sessionId ? modeBySession.get(sessionId) : undefined
}

export function forgetPromptMode(sessionId: string | undefined): void {
	if (sessionId) modeBySession.delete(sessionId)
}
