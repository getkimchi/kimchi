import { getOrgPolicy } from "../../org-policy.js"
import { PERMISSION_MODES } from "./constants.js"
import type { PermissionMode } from "./types.js"

/**
 * Org-policy-derived mode restrictions. All helpers read the startup policy
 * holder and fail open: an absent policy (no key, fetch failure, unreachable)
 * means every mode is allowed.
 */

const ALL_MODES: readonly PermissionMode[] = PERMISSION_MODES

/** Permissiveness rank, independent of the canonical cycle order in constants.ts. */
const RANK: Record<PermissionMode, number> = { plan: 0, default: 1, auto: 2, yolo: 3 }

/** The modes that let ferment's background steps run without per-call approvals. */
const HIGH_MODES: readonly ("auto" | "yolo")[] = ["auto", "yolo"]

/** Whether an org policy restricts modes at all (false = unrestricted/fail-open). */
export function hasOrgPolicyRestrictions(): boolean {
	return getOrgPolicy()?.allowedPermissionModes !== undefined
}

/** The modes the org policy allows for this session. Never empty: a validated policy enables at least one mode, and anything else fails open to all. */
export function getAllowedModes(): ReadonlySet<PermissionMode> {
	const modes = getOrgPolicy()?.allowedPermissionModes
	if (!modes) return new Set(ALL_MODES)
	const allowed = ALL_MODES.filter((m) => modes[m] === true)
	// Validated policies guarantee at least one enabled mode; defend anyway.
	return allowed.length > 0 ? new Set(allowed) : new Set(ALL_MODES)
}

export function isModeAllowed(mode: PermissionMode): boolean {
	return getAllowedModes().has(mode)
}

/** The highest-ranked allowed mode from which ferment's background steps can run, if any. */
export function highestAllowedHighMode(): "auto" | "yolo" | undefined {
	const allowed = getAllowedModes()
	for (const mode of [...HIGH_MODES].reverse()) {
		if (allowed.has(mode)) return mode
	}
	return undefined
}

/**
 * The closest allowed mode to the requested one, preferring modes at or below
 * the requested permissiveness (never auto-elevate when a lower allowed mode
 * exists). Falls back to the most-restrictive allowed mode for degenerate
 * policies where nothing at or below the requested rank is allowed (e.g.
 * `{yolo only}` with `default` requested).
 */
export function clampMode(requested: PermissionMode): PermissionMode {
	const allowed = getAllowedModes()
	if (allowed.has(requested)) return requested
	const byRank = [...allowed].sort((a, b) => RANK[a] - RANK[b])
	const lower = byRank.filter((m) => RANK[m] <= RANK[requested])
	return lower.length > 0 ? lower[lower.length - 1] : byRank[0]
}

/** Whether the policy leaves any mode that can execute work (default asks per call, auto/yolo run freely; plan cannot edit). Fails open with no policy. */
export function hasExecutableMode(): boolean {
	if (!hasOrgPolicyRestrictions()) return true
	const allowed = getAllowedModes()
	return allowed.has("default") || allowed.has("auto") || allowed.has("yolo")
}

/** Whether ferment may run at all under the policy: it needs a mode whose steps can execute. */
export function isFermentRunnable(): boolean {
	return hasExecutableMode()
}

/**
 * The mode an approved plan releases into, if any. Without a restricting
 * policy this preserves the historical release to auto. Restricted policies
 * prefer the highest allowed high mode, then fall back to default: approved
 * work still executes there behind per-tool approvals. Undefined only when
 * the policy allows no executable mode (plan-only).
 */
export function releaseTargetForPlanApproval(): PermissionMode | undefined {
	if (!hasOrgPolicyRestrictions()) return "auto"
	return highestAllowedHighMode() ?? (getAllowedModes().has("default") ? "default" : undefined)
}
