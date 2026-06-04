const RUNTIME_NOT_INITIALIZED = "Extension runtime not initialized"
const STALE_EXTENSION_CONTEXT = "This extension ctx is stale after session replacement or reload"

function messageFor(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function isRuntimeNotInitialized(error: unknown): boolean {
	return messageFor(error).includes(RUNTIME_NOT_INITIALIZED)
}

function isStaleExtensionContext(error: unknown): boolean {
	return messageFor(error).includes(STALE_EXTENSION_CONTEXT)
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
				if (isRuntimeNotInitialized(error) && attempts < maxAttempts) {
					setTimeout(run, delayMs)
					return
				}
				if (isRuntimeNotInitialized(error) || isStaleExtensionContext(error)) return
				console.error("Deferred extension action failed:", error)
			})
	}

	setTimeout(run, 0)
}
