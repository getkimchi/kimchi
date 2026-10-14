import { resolveEndpoints } from "../config.js"
import { fetchWithRetry } from "../utils/http.js"

/**
 * The harness permission modes users may run, one toggle per mode. A set
 * value means exactly the enabled modes may run; the platform guarantees at
 * least one is enabled.
 */
export interface AllowedPermissionModes {
	plan: boolean
	default: boolean
	auto: boolean
	yolo: boolean
}

/**
 * Organization policy for the Kimchi harness, resolved by the platform from
 * org → team → API key (finer scope wins, per field). All fields are
 * optional: an absent field means no restriction applies (all modes allowed,
 * user's choice on reporting, resources keep their client-side defaults).
 */
export interface OrgPolicy {
	/** The permission modes users may run. */
	allowedPermissionModes?: AllowedPermissionModes
	/** Usage reporting (telemetry) control. */
	usageReporting?: "USER_CHOICE" | "FORCE_ON" | "FORCE_OFF"
	/**
	 * Per-resource control (resource id → policy) from the platform's
	 * kimchiResources map. FORCE_ON/FORCE_OFF lock the resource; ON/OFF are
	 * soft defaults the user's local choice may override. Ids are free-form
	 * per the API contract: entries for resources this harness does not know
	 * are kept here but treated as inert by the resources store.
	 */
	resources?: Record<string, ResourcePolicy>
}

/**
 * Per-resource policy carried by the platform's KimchiResourcePolicy enum
 * (proto names minus the KIMCHI_RESOURCE_POLICY_ prefix). UNSPECIFIED means
 * "no restriction" and is dropped at parse time, never surfaced to callers.
 */
export type ResourcePolicy = "ON" | "OFF" | "FORCE_ON" | "FORCE_OFF"

export type OrgPolicyFetchOutcome =
	| { kind: "policy"; orgId: string; policy: OrgPolicy | undefined }
	/** The key itself was rejected (401 on key verify): a cached policy for it can never revalidate. */
	| { kind: "revoked" }
	/** Policy resolution is denied or missing (403/404 on verify, auth failure on resolve) —
	 * no verdict on the key itself; keep any previously known policy. */
	| { kind: "no-access" }
	/** Network/timeout/server error — keep any previously known policy. */
	| { kind: "unreachable" }

const USAGE_REPORTING = new Set(["USER_CHOICE", "FORCE_ON", "FORCE_OFF"] as const)
const RESOURCE_POLICIES = new Set(["ON", "OFF", "FORCE_ON", "FORCE_OFF"] as const)
const KIMCHI_RESOURCE_POLICY_PREFIX = "KIMCHI_RESOURCE_POLICY_"

function parseEnumName<T extends string>(raw: unknown, prefix: string, known: ReadonlySet<T>): T | undefined {
	if (typeof raw !== "string" || !raw.startsWith(prefix)) return undefined
	const value = raw.slice(prefix.length)
	for (const candidate of known) {
		if (candidate === value) return candidate
	}
	return undefined
}

/**
 * Validate a bare resource policy name ("FORCE_OFF") — the representation
 * OrgPolicy carries and the org-policy cache persists. Returns undefined for
 * anything else; callers drop invalid entries rather than rejecting. The
 * wire form carries the enum-name prefix, so strip that before calling.
 */
export function parseResourcePolicyName(raw: unknown): ResourcePolicy | undefined {
	if (typeof raw !== "string") return undefined
	for (const candidate of RESOURCE_POLICIES) {
		if (candidate === raw) return candidate
	}
	return undefined
}

/**
 * Parse the allowed-modes toggle set. protojson omits false bools, so only the
 * enabled modes appear in the object; a present object with no true mode is
 * invalid on the platform side and treated as unset here. Non-boolean
 * values are ignored (degrade to disabled for that mode).
 */
function parseAllowedModes(raw: unknown): AllowedPermissionModes | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
	const source = raw as Record<string, unknown>
	const modes: AllowedPermissionModes = {
		plan: source.plan === true,
		default: source.defaultMode === true || source.default_mode === true,
		auto: source.auto === true,
		yolo: source.yolo === true,
	}
	if (!modes.plan && !modes.default && !modes.auto && !modes.yolo) return undefined
	return modes
}

/**
 * Shared walker for the resources policy map: validates the JSON object
 * shape, applies a per-value parser, and drops entries whose value does not
 * parse. The wire parser and the cache validator share these rules so their
 * acceptance behavior cannot drift. Dropping is fail-open (an unknown value
 * degrades to "no restriction") and silent: an org pushing an enum this
 * client does not know simply has no effect on the client's decisions.
 */
export function parseResourcePolicyMap(
	raw: unknown,
	parseValue: (value: unknown) => ResourcePolicy | undefined,
): Record<string, ResourcePolicy> | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
	const source = raw as Record<string, unknown>
	const policies: Record<string, ResourcePolicy> = {}
	for (const [id, value] of Object.entries(source)) {
		const policy = parseValue(value)
		if (policy) policies[id] = policy
	}
	return Object.keys(policies).length > 0 ? policies : undefined
}

/** Wire-form value: the proto enum name with its KIMCHI_RESOURCE_POLICY_ prefix. */
function parseWireResourcePolicyValue(value: unknown): ResourcePolicy | undefined {
	if (typeof value !== "string" || !value.startsWith(KIMCHI_RESOURCE_POLICY_PREFIX)) return undefined
	return parseResourcePolicyName(value.slice(KIMCHI_RESOURCE_POLICY_PREFIX.length))
}

/**
 * Parse the kimchiResources map (resource id → policy) from a
 * settings:resolve response. Values are proto enum name strings
 * ("KIMCHI_RESOURCE_POLICY_FORCE_OFF"); UNSPECIFIED, unknown names, and
 * non-string values are dropped — a resource with no surviving entry simply
 * has no restriction. Keys are free-form per the API contract, so ids this
 * harness does not know are kept: a newer platform's entries survive parse
 * and cache round trips, and the resources store treats unknown ids as
 * inert.
 */
function parseResourcePolicies(raw: unknown): Record<string, ResourcePolicy> | undefined {
	return parseResourcePolicyMap(raw, parseWireResourcePolicyValue)
}

/**
 * Parse the harness policy from a settings:resolve response. The policy is
 * carried as three fields on the Settings message
 * (kimchi_allowed_permission_modes / kimchi_usage_reporting /
 * kimchi_resources); the gateway marshals proto3 JSON with camelCase names
 * by default, and snake_case is accepted too so self-hosted gateways
 * configured with UseProtoNames keep working. Unknown or malformed values
 * are dropped rather than rejected, so a policy set by a newer platform
 * version degrades to "no restriction" instead of failing.
 */
export function parseOrgPolicy(settings: unknown): OrgPolicy | undefined {
	if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return undefined
	const source = settings as Record<string, unknown>
	const policy: OrgPolicy = {}

	const modes = parseAllowedModes(source.kimchiAllowedPermissionModes ?? source.kimchi_allowed_permission_modes)
	if (modes) policy.allowedPermissionModes = modes

	const reporting = parseEnumName(
		source.kimchiUsageReporting ?? source.kimchi_usage_reporting,
		"KIMCHI_USAGE_REPORTING_",
		USAGE_REPORTING,
	)
	if (reporting) policy.usageReporting = reporting

	const resources = parseResourcePolicies(source.kimchiResources ?? source.kimchi_resources)
	if (resources) policy.resources = resources

	if (!policy.allowedPermissionModes && policy.usageReporting === undefined && !policy.resources) return undefined
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
		// 401 is a verdict on the key itself; 403/404 may be gateway or platform
		// state and must not wipe a cached policy.
		if (verifyResp.status === 401) return { kind: "revoked" }
		if (verifyResp.status === 403 || verifyResp.status === 404) return { kind: "no-access" }
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
		// A 401 here — right after a successful verify — is treated like 403/404:
		// no verdict on the key, so any cached policy is kept.
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
