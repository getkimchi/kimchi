/**
 * Per-region OAuth (Authorization Code + PKCE) metadata for CAST AI SSO login.
 *
 * Each region maps to its CAST AI Auth0 tenant (authorize/token URLs) plus the
 * native-app client id. The client id is a public identifier, not a secret, so
 * built-in defaults are safe to ship.
 *
 * Env overrides (resolved region first, then global):
 *   KIMCHI_OAUTH_CLIENT_ID_<REGION>  e.g. KIMCHI_OAUTH_CLIENT_ID_US
 *   KIMCHI_OAUTH_CLIENT_ID
 *   KIMCHI_OAUTH_AUTHORIZE_URL       dev/mock authorization-server override
 *   KIMCHI_OAUTH_TOKEN_URL           dev/mock token-endpoint override
 *   KIMCHI_ORGANIZATIONS_URL         dev/mock override for the user-organizations listing
 *   KIMCHI_OAUTH_AUDIENCE            optional `audience` authorize/token param
 *   KIMCHI_OAUTH_USE_ID_TOKEN        "1"/"true": send the ID token to the
 *                                    gateway instead of the access token
 *                                    (default until the gateway settles it).
 *
 * Dependency-light by design (regions.ts, no config.ts import) so the login
 * extension, oauth.ts and tests import it without import cycles.
 */

import { type KimchiRegion, REGIONS, type RegionId } from "./regions.js"

export interface KimchiOAuthConfig {
	region: RegionId
	authorizeUrl: string
	tokenUrl: string
	clientId: string
	/** Optional `audience` param for authorize and token requests (RFC 8707). */
	audience?: string
	/** GET endpoint listing the user's organizations (Cast AI users API):
	 * `${castApiUrl}/v1/organizations`. */
	organizationsUrl: string
	/** True: credential.access carries the ID token; false: the access token. */
	useIdToken: boolean
}

interface RegionOAuthDefaults {
	authorizeUrl: string
	tokenUrl: string
	clientId: string
}

// Per-region native-app clients. Client ids are public identifiers, not
// secrets. The redirect URI is exactly `http://localhost:8765/callback`
// (see CAST_AI_SSO_CALLBACK_PORT), offline_access is allowed, and
// refresh-token rotation must stay OFF — the credential fan-out shares one
// refresh token across providers (see src/pi-auth.ts).
const REGION_OAUTH_DEFAULTS: Partial<Record<RegionId, RegionOAuthDefaults>> = {
	us: {
		authorizeUrl: "https://login.kimchi.dev/authorize",
		tokenUrl: "https://login.kimchi.dev/oauth/token",
		clientId: "rG3I0gwpiMzjzv1qC2W5s21UMQlNzSlS",
	},
	eu: {
		authorizeUrl: "https://login.eu.kimchi.dev/authorize",
		tokenUrl: "https://login.eu.kimchi.dev/oauth/token",
		clientId: "Bw2sA2DJyUAN2wpGiHU72Wh2Xenw6xma",
	},
}

function boolEnv(name: string): boolean | undefined {
	const value = process.env[name]?.trim().toLowerCase()
	if (value === undefined || value === "") return undefined
	return value === "1" || value === "true" || value === "yes"
}

function nonEmptyEnv(name: string): string | undefined {
	const value = process.env[name]?.trim()
	return value ? value : undefined
}

/**
 * OAuth endpoint/client metadata for a region, with env overrides applied.
 * Returns undefined for regions without an Auth0 tenant (self-hosted) — the
 * login selector uses that to hide the SSO option.
 */
export function oauthConfigForRegion(region: KimchiRegion): KimchiOAuthConfig | undefined {
	const defaults = REGION_OAUTH_DEFAULTS[region.id]
	if (!defaults) return undefined

	const regionTag = region.id.toUpperCase().replace(/-/g, "_")
	const clientId =
		nonEmptyEnv(`KIMCHI_OAUTH_CLIENT_ID_${regionTag}`) ?? nonEmptyEnv("KIMCHI_OAUTH_CLIENT_ID") ?? defaults.clientId
	return {
		region: region.id,
		authorizeUrl: nonEmptyEnv("KIMCHI_OAUTH_AUTHORIZE_URL") ?? defaults.authorizeUrl,
		tokenUrl: nonEmptyEnv("KIMCHI_OAUTH_TOKEN_URL") ?? defaults.tokenUrl,
		clientId,
		audience: nonEmptyEnv("KIMCHI_OAUTH_AUDIENCE"),
		// The org listing lives on the Cast AI users API (castApiUrl), not the
		// Auth0 tenant — full-URL env override for dev/test (mock AS setups).
		organizationsUrl: nonEmptyEnv("KIMCHI_ORGANIZATIONS_URL") ?? `${region.castApiUrl}/v1/organizations`,
		useIdToken: boolEnv("KIMCHI_OAUTH_USE_ID_TOKEN") ?? true,
	}
}

/** Regions that can offer the SSO login: every known region with an Auth0
 * tenant (self-hosted has none). Not filtered by the region selector's
 * availability gating — SSO regions are available wherever the tenant is
 * registered. */
export function ssoAvailableRegions(regions: KimchiRegion[] = Object.values(REGIONS)): KimchiRegion[] {
	return regions.filter((region) => oauthConfigForRegion(region) !== undefined)
}

// ---------------------------------------------------------------------------
// Pending login region
//
// The provider-level OAuth login (`ExtensionOAuthConfig.login`) is registered
// once for `kimchi-dev`, but the region is picked in the selector immediately
// before the login dialog opens. The selector hands the choice over through
// setPendingOAuthRegion; resolveOAuthLoginConfig prefers it, then falls back
// to the configured region. login() clears it once consumed so a later login
// without a fresh selector pass never reuses a stale region.
// ---------------------------------------------------------------------------

let pendingOAuthRegion: RegionId | undefined

export function setPendingOAuthRegion(region: RegionId | undefined): void {
	pendingOAuthRegion = region
}

/** Exported for tests. */
export function resetPendingOAuthRegionForTests(): void {
	pendingOAuthRegion = undefined
}

/**
 * Resolve the OAuth config for an imminent login: pending selector region
 * first, then the stored region. Returns undefined when no region is known or
 * the region has no Auth0 tenant. `storedRegion` is injected (loadConfig's
 * value) so this module stays import-light.
 */
export function resolveOAuthLoginConfig(storedRegion: RegionId | undefined): KimchiOAuthConfig | undefined {
	const region = pendingOAuthRegion ?? storedRegion
	if (!region) return undefined
	// oauthConfigForRegion maps the region through REGION_OAUTH_DEFAULTS and
	// returns undefined for tenants without one (self-hosted).
	return oauthConfigForRegion(REGIONS[region])
}

/** Consume the pending region (called by login() once it has read it). */
export function clearPendingOAuthRegion(): void {
	pendingOAuthRegion = undefined
}
