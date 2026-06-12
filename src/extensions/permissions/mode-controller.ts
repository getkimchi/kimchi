import { PERMISSIONS_ENV_KEY } from "./constants.js"
import {
	getSessionPermissionFlagController,
	registerSessionPermissionFlagController,
} from "./mode-controller-registry.js"
import { parseModeString } from "./mode.js"
import type {
	PermissionMode,
	PermissionModeRuntimeSource,
	SessionPermissionFlagChanges,
	SessionPermissionFlagController,
} from "./types.js"

/**
 * Create a session-scoped permission mode controller.
 * Each agent/subagent session gets its own controller, isolating mode changes
 * from other sessions while still respecting initial CLI flag/env values.
 */
export function createSessionPermissionFlagController(
	initialFlags: {
		mode?: {
			mode: PermissionMode
			source: PermissionModeRuntimeSource
		}
	} = {},
): SessionPermissionFlagController {
	let mode = initialFlags.mode ?? { mode: "default", source: "user" }
	const listeners = new Set<(changes: SessionPermissionFlagChanges) => void>()

	return {
		getMode: () => mode,
		setMode: (newMode, source, skipNotify) => {
			mode = { mode: newMode, source }
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

export function setPermissionMode(
	sessionId: string,
	mode: PermissionMode,
	source: PermissionModeRuntimeSource,
	skipNotify?: boolean,
): void {
	const sessionController = getSessionPermissionFlagController(sessionId)
	if (sessionController) {
		sessionController.setMode(mode, source, skipNotify)
	} else {
		const controller = createSessionPermissionFlagController({ mode: { mode, source } })
		registerSessionPermissionFlagController(sessionId, controller)
	}
	persistPermissionMode(sessionId, mode)
}

/**
 * Returns the current permission mode for the given sessionId.
 * Returns undefined if no persisted mode is found for the session.
 */
export function getPermissionMode(
	sessionId: string,
): { mode: PermissionMode; source: PermissionModeRuntimeSource } | undefined {
	const sessionController = getSessionPermissionFlagController(sessionId)
	if (sessionController) {
		return sessionController.getMode()
	}
	const envKey = getSessionPermissionsEnvKey(sessionId)
	const mode = parseModeString(process.env[envKey])
	if (mode) {
		setPermissionMode(sessionId, mode, "user")
		return { mode, source: "user" }
	}
	return undefined
}
