import type { PermissionMode, PermissionModeMeta, PermissionsConfig } from "./types.js"

export const PERMISSIONS_ENV_KEY = "KIMCHI_PERMISSIONS"

export const PERMISSION_MODES: readonly PermissionMode[] = ["default", "plan", "auto", "yolo"] as const

export const PERMISSION_MODE_META: Record<PermissionMode, PermissionModeMeta> = {
	default: {
		label: "Ask before edits",
		tuiLabel: "default",
		description: "Approves every file change before it's made",
		color: "success",
	},
	plan: {
		label: "Plan",
		tuiLabel: "plan",
		description: "Thinks and plans, no edits",
		color: "warning",
	},
	auto: {
		label: "Auto",
		tuiLabel: "auto",
		description: "Runs freely, asks only for high-risk actions",
		color: "warning",
	},
	yolo: {
		label: "YOLO",
		tuiLabel: "yolo",
		description: "No permissions asked (use in sandboxed environments)",
		color: "error",
	},
}

export const PERMISSION_MODES_WITH_META: Array<PermissionModeMeta & { mode: PermissionMode }> = PERMISSION_MODES.map(
	(mode) => ({ mode, ...PERMISSION_MODE_META[mode] }),
)

export const DEFAULT_CONFIG: PermissionsConfig = {
	defaultMode: "default",
	allow: [],
	deny: [],
	classifierTimeoutMs: 8000,
}

/**
 * Denylist applied as the lowest-precedence rule source. Users can override by
 * adding matching allow rules at a higher-precedence source.
 */
export const BUILTIN_DENY: string[] = [
	"bash(rm -rf /*)",
	"bash(sudo *)",
	"write(.env)",
	"write(.env.*)",
	"edit(.env)",
	"edit(.env.*)",
]
