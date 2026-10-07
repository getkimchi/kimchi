import { resolveEndpoints } from "../config.js"
import { fetchWithRetry } from "../utils/http.js"

/**
 * Organization policy for the Kimchi harness, resolved by the platform from
 * org → team → API key (finer scope wins, per field). Both fields are
 * optional: an absent field means no restriction applies.
 */
export interface OrgPolicy {
	/** The most permissive permission mode users may run. */
	maxPermissionMode?: "PLAN" | "DEFAULT" | "AUTO" | "YOLO"
	/** Usage reporting (telemetry) control. */
	usageReporting?: "USER_CHOICE" | "FORCE_ON" | "FORCE_OFF"
}

export type OrgPolicyFetchOutcome =
	| { kind: "policy"; orgId: string; policy: OrgPolicy | undefined }
	/** The key is not usable for policy resolution (401/403/404) — treat as no policy. */
	| { kind: "no-access" }
	/** Network/timeout/server error — keep any previously known policy. */
	| { kind: "unreachable" }

const PERMISSION_MODES = new Set(["PLAN", "DEFAULT", "AUTO", "YOLO"] as const)
const USAGE_REPORTING = new Set(["USER_CHOICE", "FORCE_ON", "FORCE_OFF"] as const)

function parseEnumName<T extends string>(raw: unknown, prefix: string, known: ReadonlySet<T>): T | undefined {
	if (typeof raw !== "string" || !raw.startsWith(prefix)) return undefined
	const value = raw.slice(prefix.length)
	for (const candidate of known) {
		if (candidate === value) return candidate
	}
	return undefined
}

/**
 * Parse the kimchi_policy object from a settings:resolve response. Unknown or
 * malformed enum values are dropped rather than rejected, so a policy set by
 * a newer platform version degrades to "no restriction" instead of failing.
 */
export function parseOrgPolicy(raw: unknown): OrgPolicy | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
	const source = raw as Record<string, unknown>
	const policy: OrgPolicy = {}

	const maxPermissionMode = parseEnumName(source.maxPermissionMode, "KIMCHI_PERMISSION_MODE_", PERMISSION_MODES)
	if (maxPermissionMode) policy.maxPermissionMode = maxPermissionMode

	const usageReporting = parseEnumName(source.usageReporting, "KIMCHI_USAGE_REPORTING_", USAGE_REPORTING)
	if (usageReporting) policy.usageReporting = usageReporting

	if (policy.maxPermissionMode === undefined && policy.usageReporting === undefined) return undefined
	return policy
}

/**
 * Fetch the effective harness policy for the given API key by resolving
 * settings:resolve on the platform gateway. Never throws: failures are
 * reported through the outcome kind so callers can fail open.
 */
export async function fetchOrgPolicy(
	apiKey: string,
	options?: { fetch?: typeof globalThis.fetch },
): Promise<OrgPolicyFetchOutcome> {
	const endpoint = resolveEndpoints().platformApiUrl
	const fetchImpl = options?.fetch ?? globalThis.fetch

	let orgId: string
	try {
		// Reuses the verify call so the org is authoritative for this key.
		const { verifyApiKey } = await import("./organizations.js")
		orgId = (await verifyApiKey(apiKey, { fetch: fetchImpl })).organizationId
	} catch (err) {
		// verifyApiKey reports HTTP failures as "... failed with HTTP <status>"
		// and propagates network/timeout errors as anything else. Only a
		// definitive rejection (bad key, unknown org) clears the cached policy;
		// transient errors keep the last known good one.
		const status = /HTTP (\d{3})/.exec(err instanceof Error ? err.message : "")?.[1]
		if (status === "401" || status === "403" || status === "404") return { kind: "no-access" }
		return { kind: "unreachable" }
	}

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/settings:resolve`
	let resp: Response
	try {
		resp = await fetchWithRetry(
			url,
			{
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
			},
			// Startup path: fail fast and keep whatever is cached. The default
			// retry budget (10 attempts, up to 60s backoff) would stall boot.
			{ fetchImpl, timeoutMs: 1500, retry: { maxRetries: 0 } },
		)
	} catch {
		return { kind: "unreachable" }
	}

	if (!resp.ok) {
		if (resp.status === 401 || resp.status === 403 || resp.status === 404) return { kind: "no-access" }
		return { kind: "unreachable" }
	}

	const data: unknown = await resp.json().catch(() => null)
	if (data === null || typeof data !== "object") return { kind: "no-access" }

	return {
		kind: "policy",
		orgId,
		policy: parseOrgPolicy((data as Record<string, unknown>).kimchi_policy),
	}
}
