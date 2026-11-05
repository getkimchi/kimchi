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

const bySessionId = new Map<string, SessionPermissionFlagController>()

/**
 * Register a mode controller for a specific session.
 */
export function registerSessionPermissionFlagController(
	sessionId: string,
	controller: SessionPermissionFlagController,
): void {
	bySessionId.set(sessionId, controller)
}

/**
 * Unregister a session's mode controller. Called by ACP when closing a
 * session. Id keys recycle across concurrent attaches (load+resume of one
 * id coalesce separately), respawns, and failed loads, so callers that
 * registered a SPECIFIC controller pass it back for an identity check — a
 * by-key delete could otherwise evict a LIVE session's controller (e.g.
 * loading a corrupted duplicate of a running session's file). Returns
 * whether the entry was actually evicted, so env cleanup stays paired.
 */
export function unregisterSessionPermissionFlagController(
	sessionId: string,
	expected?: SessionPermissionFlagController,
): boolean {
	if (expected !== undefined && bySessionId.get(sessionId) !== expected) return false
	return bySessionId.delete(sessionId)
}

/**
 * Get a session's mode controller if one exists.
 */
export function getSessionPermissionFlagController(sessionId: string): SessionPermissionFlagController | undefined {
	return bySessionId.get(sessionId)
}

/**
 * Check if a session has a registered mode controller.
 */
export function hasSessionPermissionFlagController(sessionId: string): boolean {
	return bySessionId.has(sessionId)
}
