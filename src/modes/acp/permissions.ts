import type {
	PermissionMode,
	SessionPermissionFlagChanges,
	SessionPermissionFlagController,
} from "../../extensions/permissions/types.js"

/**
 * Create a session-scoped permission mode controller.
 * Each ACP session gets its own controller, isolating mode changes
 * from other sessions while still respecting initial CLI flag/env values.
 */
export function createSessionPermissionFlagController(
	initialFlags: { mode?: PermissionMode } = {},
): SessionPermissionFlagController {
	let mode = initialFlags.mode ?? "default"
	const listeners = new Set<(changes: SessionPermissionFlagChanges) => void>()

	return {
		getMode: () => mode,
		setMode: (newMode) => {
			mode = newMode
			for (const _l of listeners) _l({ mode })
		},
		subscribe: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
}
