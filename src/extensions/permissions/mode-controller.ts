import { PERMISSIONS_ENV_KEY } from "./constants.js"
import {
	getSessionPermissionFlagController,
	registerSessionPermissionFlagController,
} from "./mode-controller-registry.js"
import { parseModeString } from "./mode.js"
import type { PermissionMode, SessionPermissionFlagChanges, SessionPermissionFlagController } from "./types.js"

/**
 * Create a session-scoped permission mode controller.
 * Each agent/subagent session gets its own controller, isolating mode changes
 * from other sessions while still respecting initial CLI flag/env values.
 */
export function createSessionPermissionFlagController(
	initialFlags: { mode?: PermissionMode } = {},
): SessionPermissionFlagController {
	let mode = initialFlags.mode ?? "default"
	const listeners = new Set<(changes: SessionPermissionFlagChanges) => void>()

	return {
		getMode: () => mode,
		setMode: (newMode, skipNotify) => {
			mode = newMode
			if (!skipNotify) {
				for (const _l of listeners) _l({ mode })
			}
		},
		subscribe: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
}

export function getSessionPermissionsEnvKey(sessionId: string): string {
	return `${PERMISSIONS_ENV_KEY}_${sessionId}`
}

function persistPermissionMode(sessionId: string, mode: PermissionMode): void {
	process.env[getSessionPermissionsEnvKey(sessionId)] = mode
}

export function clearPermissionMode(sessionId: string): void {
	Reflect.deleteProperty(process.env, getSessionPermissionsEnvKey(sessionId))
}

export function setPermissionMode(sessionId: string, mode: PermissionMode, skipNotify = false): void {
	const sessionController = getSessionPermissionFlagController(sessionId)
	if (sessionController) {
		sessionController.setMode(mode, skipNotify)
	} else {
		const controller = createSessionPermissionFlagController({ mode })
		registerSessionPermissionFlagController(sessionId, controller)
	}
	persistPermissionMode(sessionId, mode)
}

export function getPermissionMode(sessionId: string): PermissionMode {
	const sessionController = getSessionPermissionFlagController(sessionId)
	if (sessionController) {
		return sessionController.getMode()
	}
	const envKey = getSessionPermissionsEnvKey(sessionId)
	const mode = parseModeString(process.env[envKey])
	if (mode) {
		setPermissionMode(sessionId, mode, true)
		return mode
	}
	throw Error(
		`No permission mode could be found for session ${sessionId}. This is likely an error in the harness code.`,
	)
}
