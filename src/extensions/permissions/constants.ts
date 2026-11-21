import type { PermissionMode, PermissionModeMeta, PermissionsConfig } from "./types.js"

export const PERMISSIONS_ENV_KEY = "KIMCHI_PERMISSIONS"

/**
 * DANGER: Bypass flag that disables ALL permission checks.
 * WARNING: This skips denylist, rules, classifier, and prompts.
 * For throwaway/sandboxed environments ONLY.
 */
export const DANGEROUS_BYPASS_FLAG = "dangerously-skip-permissions"

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
		description:
			"Auto-approves; deny rules still enforced unless --dangerously-skip-permissions is set (sandboxed environments)",
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
	classifierMaxTotalMs: 25_000,
}

/** How long the classifier breaker stays open after a transport-class failure before probing again. */
export const CLASSIFIER_BREAKER_WINDOW_MS = 60_000

/**
 * How long the permission mode must stay unchanged before a call whose prompt
 * a mode change withdrew is decided again. Shift+Tab reaches a mode by passing
 * through the ones before it, so the call must be decided under the mode the
 * user stops on, not one they only passed through.
 */
export const MODE_SETTLE_MS = 400

/** Answer budget for an escalated subagent permission request, measured
 *  from the moment the prompt is shown (or sent to the client). It covers
 *  the selector and its feedback input, and starts again when a selector is
 *  reopened. Time spent held back or queued does not count. */
export const ESCALATED_PROMPT_TIMEOUT_MS = 5 * 60_000

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
