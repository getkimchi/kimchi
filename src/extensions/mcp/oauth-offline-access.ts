import { type AuthorizationUrlTransform, setAuthorizationUrlTransform } from "pi-mcp-adapter/oauth"

/**
 * Offline-access request parameters for OAuth MCP servers.
 *
 * A refresh token is what keeps a signed-in user from repeating the browser consent whenever the
 * access token expires, but OAuth never made requesting one uniform: OIDC standardized the
 * `offline_access` scope (Microsoft, Okta, Auth0, Keycloak advertise it in the authorization
 * server's `scopes_supported` metadata), while Google's server — predating that spec — issues one
 * only for a proprietary `access_type=offline` authorization parameter and actively rejects the
 * scope with invalid_scope (https://developers.google.com/workspace/guides/configure-mcp-servers).
 *
 * Applied to each authorize URL right before it is opened, using the discovery state the adapter
 * already holds for that flow (no extra network traffic), in two stages:
 *   1. advertise-and-extend: when the authorization server's metadata lists `offline_access`,
 *      append it to the URL's scope (only when a scope is being requested at all);
 *   2. vendor table: per-authorization-endpoint-host extra parameters for servers that use a
 *      proprietary mechanism.
 * The adapter applies the server's own `oauth.authorizationParams` before this runs, and both
 * stages only fill in what is absent, so explicit configuration always wins.
 */

/** Extra authorization parameters an endpoint host needs to mint a refresh token. */
const VENDOR_OFFLINE_AUTH_PARAMS: ReadonlyArray<readonly [host: string, params: Readonly<Record<string, string>>]> = [
	["accounts.google.com", { access_type: "offline", prompt: "consent" }],
]

const OFFLINE_ACCESS_SCOPE = "offline_access"

type DiscoveryState = Parameters<AuthorizationUrlTransform>[1]

/** Discovery documents come from the network; only trust the shape of what is read. */
function advertisesOfflineAccess(discovery: DiscoveryState): boolean {
	const supported: unknown = discovery?.authorizationServerMetadata?.scopes_supported
	return Array.isArray(supported) && supported.includes(OFFLINE_ACCESS_SCOPE)
}

export const applyOfflineAccessToAuthorizationUrl: AuthorizationUrlTransform = (url, discovery) => {
	const next = new URL(url.toString())

	const scope = next.searchParams.get("scope")
	if (scope !== null && advertisesOfflineAccess(discovery) && !scope.split(/\s+/).includes(OFFLINE_ACCESS_SCOPE)) {
		next.searchParams.set("scope", `${scope} ${OFFLINE_ACCESS_SCOPE}`)
	}

	const vendor = VENDOR_OFFLINE_AUTH_PARAMS.find(([host]) => host === next.hostname)
	if (vendor !== undefined) {
		for (const [key, value] of Object.entries(vendor[1])) {
			if (!next.searchParams.has(key)) next.searchParams.set(key, value)
		}
	}
	return next
}

/**
 * Installs the transform process-wide. Stateless and idempotent: every session and the probe
 * install the same pure function, so concurrent sessions never see differing behavior and no
 * teardown ever needs to uninstall it.
 */
export function installOfflineAccessAuthorizationUrlTransform(): void {
	setAuthorizationUrlTransform(applyOfflineAccessToAuthorizationUrl)
}
