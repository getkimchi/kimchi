/**
 * Session-scoped process-registry accessor.
 *
 * Lives in its own module (not the `./index.js` barrel) so consumers like
 * `bash-control-tool.ts` and `bash-control-extension.ts` don't import the
 * barrel — which would make the folder's module graph bidirectional.
 *
 * Lifecycle: `bashBackgroundExtension` (index.ts) installs a fresh registry
 * on `session_start` and clears it on `session_shutdown` after draining it.
 */
import type { ProcessRegistry } from "./process-registry.js"

let sessionRegistry: ProcessRegistry | undefined

/** The active session's registry, or undefined outside a session. */
export function getSessionRegistry(): ProcessRegistry | undefined {
	return sessionRegistry
}

/** Install (or clear) the session-scoped registry. Owned by bashBackgroundExtension. */
export function setSessionRegistry(registry: ProcessRegistry | undefined): void {
	sessionRegistry = registry
}
