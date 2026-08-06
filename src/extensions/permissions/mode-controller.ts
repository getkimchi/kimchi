import type { CustomEntry, ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent"
import { PERMISSIONS_ENV_KEY } from "./constants.js"
import { parseModeString } from "./mode.js"
import {
	getSessionPermissionFlagController,
	registerSessionPermissionFlagController,
} from "./mode-controller-registry.js"
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

function setEnvPermissionMode(sessionId: string, mode: PermissionMode): void {
	process.env[getSessionPermissionsEnvKey(sessionId)] = mode
}

export function clearPermissionMode(sessionId: string): void {
	Reflect.deleteProperty(process.env, getSessionPermissionsEnvKey(sessionId))
}

// =============================================================================
// Session-log persistence (mirrors src/extensions/multi-model.ts)
// =============================================================================

/** Custom session entry type used to cache the last permission mode. */
export const PERMISSION_MODE_SESSION_ENTRY_TYPE = "permission_mode"

/** Payload shape stored in the session log. */
export interface PersistedPermissionMode {
	mode: PermissionMode
	source: PermissionModeRuntimeSource
}

/** Source tag for `resolvePermissionMode`'s precedence reporting. */
export type PermissionModeResolutionSource = "runtime" | "cli" | "persisted" | "global"

export interface PermissionModeResolution {
	mode: PermissionMode
	source: PermissionModeResolutionSource
}

/** Append-handle union for the reconciler (accepts either a SessionManager or an ExtensionAPI). */
export type PermissionModeAppendCtx = Pick<SessionManager, "appendCustomEntry"> | Pick<ExtensionAPI, "appendEntry">

/** Whether --yolo / --dangerously-skip-permissions was passed on the CLI for this process. */
export function hasExplicitCliPermissionMode(): boolean {
	const args = process.argv
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--yolo" || a === "--dangerously-skip-permissions") return true
	}
	return false
}

/** Read ONLY the persisted value from the session log. Returns the most recent entry or undefined. */
export function getSessionLogPermissionMode(
	sessionManager: Pick<SessionManager, "getEntries"> | null | undefined,
): PersistedPermissionMode | undefined {
	if (!sessionManager) return undefined
	const last = sessionManager
		.getEntries()
		.findLast(
			(entry): entry is CustomEntry<PersistedPermissionMode> =>
				entry.type === "custom" && entry.customType === PERMISSION_MODE_SESSION_ENTRY_TYPE,
		)
	return last?.data
}

/**
 * Resolve the effective permission mode AND its precedence layer.
 *
 * Precedence (highest to lowest):
 *   1. runtime  — per-session in-memory controller (already hydrated at bootstrap)
 *   2. cli      — --yolo / --dangerously-skip-permissions passed for this invocation
 *   3. persisted — last `permission_mode` custom entry in the session log
 *   4. global   — hardcoded "default"
 *
 * The source tag is exposed so callers (telemetry, bootstrap) can report which
 * layer won. Internal callers that just need the mode + runtime source should
 * use the per-session controller via `getPermissionMode(sessionId)` instead.
 */
export function resolvePermissionMode(
	sessionManager: Pick<SessionManager, "getEntries" | "getSessionId"> | null | undefined,
): PermissionModeResolution {
	// 1. Runtime controller
	if (sessionManager) {
		const controller = getSessionPermissionFlagController(sessionManager.getSessionId())
		if (controller) {
			const m = controller.getMode()
			return { mode: m.mode, source: "runtime" }
		}
	}

	// 2. CLI flag
	if (hasExplicitCliPermissionMode()) {
		return { mode: "yolo", source: "cli" }
	}

	// 3. Persisted session entry
	if (sessionManager) {
		const persisted = getSessionLogPermissionMode(sessionManager)
		if (persisted) return { mode: persisted.mode, source: "persisted" }
	}

	// 4. Global default
	return { mode: "default", source: "global" }
}

/**
 * Sync the mode to the runtime controller and the per-session env variable.
 *
 * Does NOT write to the session log. Use `setAndPersistPermissionMode` when
 * the change should also be persisted for resume.
 */
export function setPermissionMode(
	sessionId: string,
	mode: PermissionMode,
	source: PermissionModeRuntimeSource,
	skipNotify?: boolean,
): void {
	const controller = getSessionPermissionFlagController(sessionId)
	if (controller) {
		controller.setMode(mode, source, skipNotify)
	} else {
		registerSessionPermissionFlagController(
			sessionId,
			createSessionPermissionFlagController({ mode: { mode, source } }),
		)
	}
	setEnvPermissionMode(sessionId, mode)
}

export function setAndPersistPermissionMode(args: {
	sessionManager: Pick<SessionManager, "getEntries" | "getSessionId">
	appendCtx: PermissionModeAppendCtx
	mode: PermissionMode
	source: PermissionModeRuntimeSource
	skipNotify?: boolean
}): void {
	const { sessionManager, appendCtx, mode, source, skipNotify } = args
	const sessionId = sessionManager.getSessionId()

	setPermissionMode(sessionId, mode, source, skipNotify)

	// Persist to session log when effective mode differs from last persisted
	const persisted = getSessionLogPermissionMode(sessionManager)
	if (persisted?.mode !== mode) {
		const append = "appendCustomEntry" in appendCtx ? appendCtx.appendCustomEntry : appendCtx.appendEntry
		append(PERMISSION_MODE_SESSION_ENTRY_TYPE, { mode, source })
	}
}

/**
 * Returns the current permission mode for the given sessionId.
 * Returns undefined if no persisted mode is found for the session.
 */
export function getPermissionMode(sessionId: string): PersistedPermissionMode | undefined {
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
