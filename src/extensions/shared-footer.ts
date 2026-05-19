const sharedFooterRenderers = new Set<() => void>()

let sessionModeOnboardingFooterSuppressed = false

export function registerSharedFooterRenderer(requestRender: () => void): () => void {
	sharedFooterRenderers.add(requestRender)
	return () => {
		sharedFooterRenderers.delete(requestRender)
	}
}

export function requestSharedFooterRender(): void {
	for (const requestRender of sharedFooterRenderers) requestRender()
}

export function isSessionModeOnboardingFooterSuppressed(): boolean {
	return sessionModeOnboardingFooterSuppressed
}

export function setSessionModeOnboardingFooterSuppressed(suppressed: boolean): void {
	if (sessionModeOnboardingFooterSuppressed === suppressed) return
	sessionModeOnboardingFooterSuppressed = suppressed
	requestSharedFooterRender()
}
