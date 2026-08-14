import type { CustomEntry, SessionManager } from "@earendil-works/pi-coding-agent"
import { PARENT_SESSION_ID_ENV_KEY } from "../agents/manager/constants.js"
import type { LoadedConfig } from "./config.js"
import { PERMISSIONS_ENV_KEY } from "./constants.js"
import { PERMISSION_MODE_SESSION_ENTRY_TYPE, parseModeString, resolveMode } from "./mode.js"
import {
	getSessionPermissionFlagController,
	registerSessionPermissionFlagController,
} from "./mode-controller-registry.js"
import type {
	PermissionMode,
	PermissionModeState,
	SessionPermissionFlagChanges,
	SessionPermissionFlagController,
} from "./types.js"

/**
 * Create a session-scoped permission mode controller.
 * Each agent/subagent session gets its own controller, isolating mode changes
 * from other sessions while still respecting initial CLI flag/env values.
 */
export function createSessionPermissionFlagController(initialFlags: {
	mode: PermissionModeState
}): SessionPermissionFlagController {
	let mode = initialFlags.mode
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

export function getPermissionModeEnvKey(sessionId: string): string {
	return `${PERMISSIONS_ENV_KEY}_${sessionId}`
}

function setPermissionModeEnv(sessionId: string, mode: PermissionMode): void {
	process.env[getPermissionModeEnvKey(sessionId)] = mode
}

export function clearPermissionModeEnv(sessionId: string): void {
	Reflect.deleteProperty(process.env, getPermissionModeEnvKey(sessionId))
}

export function setPermissionMode(sessionId: string, mode: PermissionModeState, skipNotify?: boolean): void {
	const sessionController = getSessionPermissionFlagController(sessionId)
	if (sessionController) {
		sessionController.setMode(mode, skipNotify)
	} else {
		const controller = createSessionPermissionFlagController({ mode })
		registerSessionPermissionFlagController(sessionId, controller)
	}
	setPermissionModeEnv(sessionId, mode.mode)
}

/**
 * Returns the current permission mode for the given sessionId.
 * Returns undefined if no persisted mode is found for the session.
 */
export function getPermissionMode(sessionId: string): PermissionModeState | undefined {
	const sessionController = getSessionPermissionFlagController(sessionId)
	if (sessionController) {
		return sessionController.getMode()
	}
	const envKey = getPermissionModeEnvKey(sessionId)
	const mode = parseModeString(process.env[envKey])
	if (mode) {
		// Runtime because this env is keyed by session id which is a runtime setting
		const state: PermissionModeState = { mode, initiatedBy: "user", source: "runtime" }
		setPermissionMode(sessionId, state)
		return state
	}
	return undefined
}

/**
 * Read the last persisted permission_mode entry from session entries.
 * Returns undefined if no entry is found.
 */
export function getPersistedPermissionMode(
	sessionManager: Pick<SessionManager, "getEntries">,
	filterBy?: (state: PermissionModeState) => boolean,
): PermissionModeState | undefined {
	const entries = sessionManager.getEntries()
	for (let i = entries.length - 1; i >= 0; i--) {
		const item = entries[i]
		if (item.type !== "custom" || item.customType !== PERMISSION_MODE_SESSION_ENTRY_TYPE) continue
		const data = (item as CustomEntry<PermissionModeState>).data
		if (!data || (filterBy && !filterBy(data))) continue
		return data
	}
	return undefined
}

/**
 * Append a permission_mode custom entry if its mode or owner differs from the
 * last logged value. Comparison is against the truly-last entry (including
 * ferment-owned ones): comparing only against user entries would re-append a
 * ferment elevation on every turn, since the resume read skips those entries;
 * comparing only the mode would swallow a user override of an active ferment
 * elevation and lose it on resume.
 * Returns true when a new entry was written.
 */
export function persistPermissionModeIfChanged(
	sessionManager: Pick<SessionManager, "getEntries">,
	appendEntry: (customType: string, data: PermissionModeState) => void,
	mode: PermissionModeState,
): boolean {
	const lastLogged = getPersistedPermissionMode(sessionManager)
	if (lastLogged?.mode === mode.mode && lastLogged.initiatedBy === mode.initiatedBy) return false
	appendEntry(PERMISSION_MODE_SESSION_ENTRY_TYPE, mode)
	return true
}

/**
 * Resolve the initial permission mode for a session using the full precedence
 * chain: runtime controller (including inherited parent mode) > CLI flag >
 * env var > persisted session log > config default > built-in default. ACP
 * has no CLI flag input, so callers there always pass `undefined` for it.
 *
 * Subagents/delegated sessions inherit the parent session's current mode via
 * the parent's per-session env key; that inherited value is treated as runtime
 * state so it outranks the child session's own log.
 */
export function resolveInitialPermissionMode(
	sessionManager: Pick<SessionManager, "getSessionId" | "getEntries">,
	permissionsEnvFlag: string | undefined,
	cliFlag: PermissionMode | undefined,
	config: LoadedConfig,
): PermissionModeState {
	const sessionId = sessionManager.getSessionId()
	const runtimeMode = getPermissionMode(sessionId)

	// Subagents inherit the parent session's current mode via the parent's
	// per-session env key. Treat that inherited value as runtime state so it
	// outranks the subagent's own session log.
	const parentSessionId = process.env[PARENT_SESSION_ID_ENV_KEY]
	const inheritedMode = parentSessionId
		? parseModeString(process.env[getPermissionModeEnvKey(parentSessionId)])
		: undefined
	const effectiveRuntime =
		runtimeMode ?? (inheritedMode ? { mode: inheritedMode, source: "runtime", initiatedBy: "user" } : undefined)

	const persistedMode = getPersistedPermissionMode(sessionManager, (state) => state.initiatedBy === "user")
	return {
		...resolveMode({
			runtime: effectiveRuntime,
			flag: cliFlag,
			env: permissionsEnvFlag,
			persisted: persistedMode,
			config: config.config.defaultMode,
		}),
		initiatedBy: "user",
	}
}
