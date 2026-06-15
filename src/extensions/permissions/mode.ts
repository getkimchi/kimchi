import { ALL_PERMISSION_MODES, type PermissionMode } from "./types.js"

export interface ModeResolution {
	mode: PermissionMode
	source: "flag" | "env" | "config"
}

export interface ModeResolutionInput {
	/** CLI flag (--plan/--auto) */
	flag: PermissionMode | undefined
	/** KIMCHI_PERMISSIONS env var */
	env: string | undefined
	/** defaultMode from merged permissions.json */
	config: PermissionMode
}

export function parseModeString(s: string | undefined): PermissionMode | undefined {
	if (!s) return undefined
	const lower = s.toLowerCase()
	if (ALL_PERMISSION_MODES.includes(lower as PermissionMode)) return lower as PermissionMode
	return undefined
}

export function resolveMode(input: ModeResolutionInput): ModeResolution {
	if (input.flag) return { mode: input.flag, source: "flag" }
	const envMode = parseModeString(input.env)
	if (envMode) return { mode: envMode, source: "env" }
	return { mode: input.config, source: "config" }
}
