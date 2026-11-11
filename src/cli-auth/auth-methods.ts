/** ACP auth-method id scheme. Base ids (`kimchi-agent`, `kimchi-sso`) follow
 * the configured region; the `kimchi-agent-<regionId>` /
 * `kimchi-sso-<regionId>` companions are pinned to that region. Shared by the
 * ACP server's initialize() advertisement and authenticate() validation so
 * the advertised list and the id parsing never drift. */
import { resolveEndpoints } from "../config.js"
import { isRegionId, type RegionId } from "../regions.js"

export const KIMCHI_AGENT_AUTH_METHOD_ID = "kimchi-agent"
export const KIMCHI_SSO_AUTH_METHOD_ID = "kimchi-sso"

/** True for `kimchi-sso` and its region-pinned companions. */
export function isSsoAuthMethodId(methodId: string): boolean {
	return methodId === KIMCHI_SSO_AUTH_METHOD_ID || methodId.startsWith(`${KIMCHI_SSO_AUTH_METHOD_ID}-`)
}

/** Region an auth method logs in to; undefined for an unknown method. Both
 * base ids follow the configured region; the `-<regionId>` companions are
 * pinned to that region. Region resolution is per-method-id on purpose — the
 * TUI's `setPendingOAuthRegion` global is single-slot and racy with two ACP
 * clients, so the ACP surface never touches it. */
export function authMethodRegion(methodId: string): RegionId | undefined {
	if (methodId === KIMCHI_AGENT_AUTH_METHOD_ID || methodId === KIMCHI_SSO_AUTH_METHOD_ID) {
		return resolveEndpoints().region
	}
	for (const prefix of [`${KIMCHI_AGENT_AUTH_METHOD_ID}-`, `${KIMCHI_SSO_AUTH_METHOD_ID}-`]) {
		if (methodId.startsWith(prefix)) {
			const suffix = methodId.slice(prefix.length)
			return isRegionId(suffix) ? suffix : undefined
		}
	}
	return undefined
}
