import { PERMISSIONS_ENV_KEY } from "./constants.js"
import { parseModeString } from "./mode.js"
import type { PermissionMode, SessionPermissionFlagChanges, SessionPermissionFlagController } from "./types.js"

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
 * Unregister a session's mode controller.
 * Called by ACP when closing a session.
 */
export function unregisterSessionPermissionFlagController(sessionId: string): void {
	bySessionId.delete(sessionId)
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
