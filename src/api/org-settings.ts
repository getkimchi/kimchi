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
 * Parse the harness policy from a settings:resolve response. The policy is
 * carried as two fields on the Settings message (kimchi_max_permission_mode /
 * kimchi_usage_reporting); the gateway marshals proto3 JSON with camelCase
 * names by default, and snake_case is accepted too so self-hosted gateways
 * configured with UseProtoNames keep working. Unknown or malformed enum
 * values are dropped rather than rejected, so a policy set by a newer
 * platform version degrades to "no restriction" instead of failing.
 */
export function parseOrgPolicy(settings: unknown): OrgPolicy | undefined {
	if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return undefined
	const source = settings as Record<string, unknown>
	const policy: OrgPolicy = {}

	const mode = parseEnumName(
		source.kimchiMaxPermissionMode ?? source.kimchi_max_permission_mode,
		"KIMCHI_PERMISSION_MODE_",
		PERMISSION_MODES,
	)
	if (mode) policy.maxPermissionMode = mode

	const reporting = parseEnumName(
		source.kimchiUsageReporting ?? source.kimchi_usage_reporting,
		"KIMCHI_USAGE_REPORTING_",
		USAGE_REPORTING,
	)
	if (reporting) policy.usageReporting = reporting

	if (policy.maxPermissionMode === undefined && policy.usageReporting === undefined) return undefined
	return policy
}

/**
 * The startup budget for policy fetches: both the key verification and the
 * resolve call run with a short timeout and no retries so a cold cache adds
 * at most a couple of seconds to startup. The fetchWithRetry default (10
 * retries, up to 60s backoff) would stall boot.
 */
const STARTUP_FETCH_OPTIONS = { timeoutMs: 1500, retry: { maxRetries: 0 } } as const

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

	// Verify the key first so the org is authoritative for it. This mirrors
	// verifyApiKey from organizations.ts but with the startup budget applied —
	// that helper's defaults (10 retries) are fine for background callers but
	// not for the blocking startup path.
	const verifyUrl = `${endpoint}/ai-optimizer/v1beta/api-keys:verify`
	let verifyResp: Response
	try {
		verifyResp = await fetchWithRetry(
			verifyUrl,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
			},
			{ ...STARTUP_FETCH_OPTIONS, fetchImpl },
		)
	} catch {
		return { kind: "unreachable" }
	}

	if (!verifyResp.ok) {
		if (verifyResp.status === 401 || verifyResp.status === 403 || verifyResp.status === 404)
			return { kind: "no-access" }
		return { kind: "unreachable" }
	}

	const verifyBody: unknown = await verifyResp.json().catch(() => null)
	if (verifyBody === null || typeof verifyBody !== "object") return { kind: "unreachable" }
	const orgId = (verifyBody as Record<string, unknown>).organizationId
	if (typeof orgId !== "string" || orgId.length === 0) return { kind: "unreachable" }

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
			{ ...STARTUP_FETCH_OPTIONS, fetchImpl },
		)
	} catch {
		return { kind: "unreachable" }
	}

	if (!resp.ok) {
		if (resp.status === 401 || resp.status === 403 || resp.status === 404) return { kind: "no-access" }
		return { kind: "unreachable" }
	}

	// A 200 with a non-JSON body is a transient gateway glitch, not a
	// definitive "no policy": keep the last known good policy.
	const data: unknown = await resp.json().catch(() => null)
	if (data === null || typeof data !== "object") return { kind: "unreachable" }

	const fields = data as Record<string, unknown>

	return {
		kind: "policy",
		orgId,
		policy: parseOrgPolicy(fields.settings),
	}
}
