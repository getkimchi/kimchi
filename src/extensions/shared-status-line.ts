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
