const RUNTIME_NOT_INITIALIZED = "Extension runtime not initialized"
const STALE_EXTENSION_CONTEXT = "This extension ctx is stale after session replacement or reload"

/**
 * Whether an extension action failure is a known-benign lifecycle state (extension
 * runtime still loading, or the captured context went stale after a session
 * replacement/reload). Callers drop these instead of surfacing them; the active
 * session re-derives its own state on startup.
 */
export function isActionBlockedError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return message.includes(RUNTIME_NOT_INITIALIZED) || message.includes(STALE_EXTENSION_CONTEXT)
}

export interface DeferredExtensionActionOptions {
	delayMs?: number
	maxAttempts?: number
}

/**
 * Run an extension action after the current lifecycle emit unwinds. Some pi-mono
 * bind paths emit session_start before action methods are wired, so retry only
 * that known startup guard and let ordinary action failures surface.
 */
export function deferExtensionAction(
	action: () => void | Promise<void>,
	options: DeferredExtensionActionOptions = {},
): void {
	const delayMs = options.delayMs ?? 20
	const maxAttempts = options.maxAttempts ?? 50
	let attempts = 0

	const run = () => {
		attempts += 1
		Promise.resolve()
			.then(action)
			.catch((error: unknown) => {
				if (attempts < maxAttempts && error instanceof Error && error.message.includes(RUNTIME_NOT_INITIALIZED)) {
					setTimeout(run, delayMs)
					return
				}
				if (isActionBlockedError(error)) return
				console.error("Deferred extension action failed:", error)
			})
	}

	setTimeout(run, 0)
}
