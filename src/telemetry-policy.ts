import type { OrgPolicy } from "./api/org-settings.js"
import { readTelemetryConfig, type TelemetryConfig } from "./config.js"
import { getOrgPolicy } from "./org-policy.js"

/**
 * Org-policy enforcement for usage reporting (telemetry). All helpers read
 * the startup policy holder and fail open: an absent policy (no key, fetch
 * failure, unreachable) or USER_CHOICE leaves the user's setting untouched.
 *
 * The policy holder is stable for the whole session — background refreshes
 * apply on the next launch — so enforcement is computed once per process and
 * never changes mid-session. Enforcement is in-memory only: the user's
 * persisted telemetry.enabled / consentVersion are never rewritten, so a
 * later USER_CHOICE transition restores their choice.
 */
export type UsageReportingPolicy = NonNullable<OrgPolicy["usageReporting"]>

/** The org's usage-reporting directive for this session, if any. */
export function usageReportingPolicy(): UsageReportingPolicy | undefined {
	return getOrgPolicy()?.usageReporting
}

/** True when the org forces telemetry on or off this session (USER_CHOICE is not enforcement). */
export function isTelemetryPolicyEnforced(): boolean {
	const policy = usageReportingPolicy()
	return policy === "FORCE_ON" || policy === "FORCE_OFF"
}

/** Apply the org directive to a user-level enabled flag; pass-through unless enforced. */
export function enforceTelemetryEnabled(userEnabled: boolean): boolean {
	const policy = usageReportingPolicy()
	if (policy === "FORCE_ON") return true
	if (policy === "FORCE_OFF") return false
	return userEnabled
}

/**
 * Return `config` with `enabled` clamped by the org policy. Identity when
 * unenforced; otherwise a shallow copy — endpoints, headers, and apiKey must
 * survive a FORCE_ON flip so reporting actually reaches the backend.
 */
export function applyTelemetryPolicy(config: TelemetryConfig): TelemetryConfig {
	const enabled = enforceTelemetryEnabled(config.enabled)
	if (enabled === config.enabled) return config
	return { ...config, enabled }
}

/** Effective telemetry gate: the user's setting with the org directive applied. */
export function isTelemetryEnabled(): boolean {
	return enforceTelemetryEnabled(readTelemetryConfig().enabled)
}

/**
 * Freshly read telemetry config with `enabled` clamped by the org policy.
 * Identity when unenforced; endpoints, headers, and apiKey survive a FORCE_ON
 * flip so reporting actually reaches the backend.
 */
export function readEffectiveTelemetryConfig(): TelemetryConfig {
	return applyTelemetryPolicy(readTelemetryConfig())
}
