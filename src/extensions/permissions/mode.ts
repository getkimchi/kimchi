import { DANGEROUS_BYPASS_FLAG, PERMISSION_MODES } from "./constants.js"
import type { PermissionMode, PermissionModeSource, PermissionModeState } from "./types.js"
export interface ModeResolution {
	mode: PermissionMode
	source: PermissionModeSource
}

export interface ModeResolutionInput {
	/** Active runtime controller value (highest precedence). */
	runtime?: PermissionModeState
	/** CLI flag value (--plan/--yolo/--auto/--dangerously-skip-permissions). */
	flag?: PermissionMode
	/** KIMCHI_PERMISSIONS env var. */
	env?: string
	/** Last persisted permission_mode session-log entry. */
	persisted?: PermissionModeState
	/** defaultMode from merged permissions.json. */
	config: PermissionMode
}

export function parseModeString(s: string | undefined): PermissionMode | undefined {
	if (!s) return undefined
	const lower = s.toLowerCase()
	if (PERMISSION_MODES.includes(lower as PermissionMode)) return lower as PermissionMode
	return undefined
}

/**
 * The permission mode requested by CLI flags, if any. Shared by the session
 * mode resolution and the pre-main ferment-oneshot validation so the
 * flag→mode mapping lives in exactly one place.
 */
export function flagModeFromOptions(options: Record<string, unknown>): PermissionMode | undefined {
	if (options.plan === true) return "plan"
	if (options.auto === true) return "auto"
	// YOLO mode: --yolo and --dangerously-skip-permissions both set yolo mode (no classifier, auto-approve all)
	if (options.yolo === true || options[DANGEROUS_BYPASS_FLAG] === true) return "yolo"
	return undefined
}

/**
 * Resolve the effective permission mode using the full precedence chain:
 * runtime controller > CLI flag > env var > persisted session log > config default > built-in default.
 */
export function resolveMode(input: ModeResolutionInput): PermissionModeState {
	if (input.runtime) return input.runtime
	if (input.flag) return { mode: input.flag, source: "flag", initiatedBy: "user" }
	const envMode = parseModeString(input.env)
	if (envMode) return { mode: envMode, source: "env", initiatedBy: "user" }
	if (input.persisted) return input.persisted
	return { mode: input.config, source: "config", initiatedBy: "user" }
}

export const PERMISSION_MODE_SESSION_ENTRY_TYPE = "permission_mode"
