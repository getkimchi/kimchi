import type { LoadedConfig } from "./config.js"
import type { PermissionModeState, Rule } from "./types.js"

/** Live permission policy owned by a main session and shared with its workers. */
export interface PermissionPolicySource {
	getMode(): PermissionModeState
	getRules(): Rule[]
	getConfig(): LoadedConfig
	isDangerBypass(): boolean
	/**
	 * Resolves once the mode has stayed unchanged for the settle time, or at
	 * once when `signal` aborts. Workers wait on their parent's clock, so a
	 * call is never decided under a mode the user only passed through.
	 */
	whenModeSettled(signal?: AbortSignal): Promise<void>
}

const sources = new Map<string, PermissionPolicySource>()

/** Register a session's live policy. The cleanup removes only this registration. */
export function registerPermissionPolicySource(sessionId: string, source: PermissionPolicySource): () => void {
	sources.set(sessionId, source)
	return () => {
		if (sources.get(sessionId) === source) sources.delete(sessionId)
	}
}

export function getPermissionPolicySource(sessionId: string): PermissionPolicySource | undefined {
	return sources.get(sessionId)
}
