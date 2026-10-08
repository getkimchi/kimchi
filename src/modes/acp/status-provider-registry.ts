import type { StatusSnapshot } from "../../extensions/status/snapshot.js"

/** Gathers the current status snapshot for the session that owns it. */
export type StatusProvider = () => StatusSnapshot

const bySessionId = new Map<string, StatusProvider>()

// Per-session gather closures registered by the status extension on
// session_start. Keeps snapshot gathering in exactly one place (the
// extension) while letting the session-external ext-method dispatch
// (`_kimchi.dev/session_status`) reach it. Unregistered on session teardown,
// mirroring the permission-prompter-registry register/unregister precedent.
export function registerStatusProvider(sessionId: string, provider: StatusProvider): void {
	bySessionId.set(sessionId, provider)
}

export function unregisterStatusProvider(sessionId: string): void {
	bySessionId.delete(sessionId)
}

export function getStatusProvider(sessionId: string): StatusProvider | undefined {
	return bySessionId.get(sessionId)
}
