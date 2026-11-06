import type { SessionPermissionFlagController } from "./types.js"

/**
 * Session-scoped permission flag controller registry.
 *
 * Maps session IDs to their respective SessionPermissionFlagController instances.
 * This allows both ACP and the permissions extension to share the same
 * session-scoped mode state, ensuring consistency between:
 * - ACP config option updates
 * - Tool-call gating decisions
 * - /permissions mode command
 * - Questionnaire auto-plan
 * - Ferment yolo mode
 */

// MULTI-OWNER slots: concurrent same-id attaches (load+resume coalesce
// separately) can both register before either installs its record — a
// plain Map.set could displace a LIVE winner's entry, after which the
// loser's legitimately identity-checked teardown would evict it.
// Registrations push; identity-checked removals pop only their own object.
const bySessionId = new Map<string, SessionPermissionFlagController[]>()

/**
 * Register a mode controller for a specific session.
 */
export function registerSessionPermissionFlagController(
	sessionId: string,
	controller: SessionPermissionFlagController,
): void {
	const list = bySessionId.get(sessionId) ?? []
	list.push(controller)
	bySessionId.set(sessionId, list)
}

/**
 * Unregister a session's mode controller. Called by ACP when closing a
 * session. Id keys recycle across concurrent attaches (load+resume of one
 * id coalesce separately), respawns, and failed loads, so callers that
 * registered a SPECIFIC controller pass it back for an identity check —
 * removing by key alone could evict a LIVE session's controller (e.g.
 * loading a corrupted duplicate of a running session's file). Without
 * `expected` the whole slot is dropped. Returns whether the requested
 * removal left the slot EMPTY, so env cleanup stays paired.
 */
export function unregisterSessionPermissionFlagController(
	sessionId: string,
	expected?: SessionPermissionFlagController,
): boolean {
	const list = bySessionId.get(sessionId)
	if (!list) return true
	if (expected === undefined) {
		bySessionId.delete(sessionId)
		return true
	}
	const idx = list.lastIndexOf(expected)
	if (idx < 0) return list.length === 0
	list.splice(idx, 1)
	if (list.length === 0) {
		bySessionId.delete(sessionId)
		return true
	}
	return false
}

/**
 * Get a session's mode controller if one exists (the latest registration).
 */
export function getSessionPermissionFlagController(sessionId: string): SessionPermissionFlagController | undefined {
	const list = bySessionId.get(sessionId)
	return list?.[list.length - 1]
}

/**
 * Check if a session has a registered mode controller.
 */
export function hasSessionPermissionFlagController(sessionId: string): boolean {
	return bySessionId.has(sessionId)
}
