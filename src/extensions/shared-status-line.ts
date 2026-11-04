// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
const sharedStatusLineRenderers = new Set<() => void>()

let sessionModeOnboardingStatusLineSuppressed = false

export function registerSharedStatusLineRenderer(requestRender: () => void): () => void {
	sharedStatusLineRenderers.add(requestRender)
	return () => {
		sharedStatusLineRenderers.delete(requestRender)
	}
}

export function requestSharedStatusLineRender(): void {
	for (const requestRender of sharedStatusLineRenderers) requestRender()
}

export function isSessionModeOnboardingStatusLineSuppressed(): boolean {
	return sessionModeOnboardingStatusLineSuppressed
}

export function setSessionModeOnboardingStatusLineSuppressed(suppressed: boolean): void {
	if (sessionModeOnboardingStatusLineSuppressed === suppressed) return
	sessionModeOnboardingStatusLineSuppressed = suppressed
	requestSharedStatusLineRender()
}
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
