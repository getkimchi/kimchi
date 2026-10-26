/**
 * One credential resolution for every call the harness makes to the Kimchi
 * LLM gateway or the CAST AI API. Mirrors the startup models-refresh
 * precedence (src/cli.ts): a configured API key (env > project > global,
 * already merged into loadConfig's apiKey) wins; otherwise the SSO/OAuth
 * credential stored in auth.json supplies the bearer, and requests carry
 * the credential's organization id as X-CastAi-Organization-Id — the
 * header the gateway routes SSO traffic by (see src/models.ts).
 *
 * Why this exists: SSO login keeps credentials ONLY in auth.json
 * (type: "oauth") and clears the config key, so loadConfig().apiKey is ""
 * for every SSO user. Callers that read config.apiKey directly break or
 * silently no-op for them (the memory extension threw
 * "memory backend embedder requires an API key"; billing, the MCP gateway
 * and web search quietly disabled themselves).
 *
 * The OAuth bearer is credential.access: whether it carries the ID token
 * or the access token was decided at login
 * (credentialFromTokenResponse in src/cli-auth/oauth.ts). No token refresh
 * happens here — same contract as the startup models refresh: request-time
 * refresh is owned by the provider's OAuth config in pi-mono. Features
 * reading a stale token fail the way they already fail on a dead key.
 *
 * Pure and synchronous (readStoredCredential is a one-off file read) so
 * every surface — TUI, ACP, the capture worker — resolves identically.
 */

import { resolve } from "node:path"
import { readStoredCredential } from "@earendil-works/pi-coding-agent"
import { KIMCHI_PROVIDER_ID } from "../kimchi-provider.js"

/** Header the gateway routes SSO requests by (mirrors models.ts). */
export const GATEWAY_ORGANIZATION_HEADER = "X-CastAi-Organization-Id"

export interface GatewayCredentials {
	/** Bearer token for the Authorization header; "" when nothing resolved. */
	token: string
	/** SSO organization id for the routing header; only set on the OAuth path. */
	organizationId?: string
	/** What supplied the token — drives per-feature messaging and gating. */
	source: "api-key" | "oauth" | "none"
}

const NONE: GatewayCredentials = { token: "", source: "none" }

/** The auth.json next to models.json — the store cli.ts and pi-auth.ts write. */
function defaultAuthPath(): string | undefined {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	return agentDir ? resolve(agentDir, "auth.json") : undefined
}

/**
 * Resolve the gateway credential: config API key first, then the stored
 * kimchi-dev auth.json credential (OAuth access token, or the api_key
 * entry syncPiAuth fans out). auth.json is user-editable JSON — validate
 * structure before reading fields; a malformed store degrades to
 * source "none" (features fall back to their keyless behavior) with a
 * logged reason, never a throw.
 */
export function resolveGatewayCredentials(
	config: Pick<{ apiKey: string }, "apiKey">,
	options: { authPath?: string } = {},
): GatewayCredentials {
	if (config.apiKey) return { token: config.apiKey, source: "api-key" }

	const authPath = options.authPath ?? defaultAuthPath()
	if (!authPath) return NONE

	let credential: ReturnType<typeof readStoredCredential>
	try {
		credential = readStoredCredential(KIMCHI_PROVIDER_ID, authPath)
	} catch (err) {
		console.error(`[gateway-credentials] could not read ${authPath}:`, err instanceof Error ? err.message : err)
		return NONE
	}
	if (!credential) return NONE

	if (credential.type === "oauth") {
		// orgId/region are Kimchi extras stamped on the credential at login
		// (completeKimchiSsoLogin) — not part of pi-ai's OAuthCredential type.
		const extras = credential as { access?: unknown; orgId?: unknown }
		if (typeof extras.access !== "string" || extras.access.length === 0) return NONE
		return {
			token: extras.access,
			organizationId: typeof extras.orgId === "string" && extras.orgId.length > 0 ? extras.orgId : undefined,
			source: "oauth",
		}
	}
	if (credential.type === "api_key") {
		const key = (credential as { key?: unknown }).key
		if (typeof key === "string" && key.length > 0) return { token: key, source: "api-key" }
	}
	return NONE
}

/**
 * Authorization (+ SSO org routing) headers for a resolved credential.
 * Omits Authorization entirely when tokenless so a feature's keyless
 * degrade path is not turned into a malformed `Bearer ` request.
 * Accepts the narrow token/organizationId shape so callers building
 * headers for a gateway object (e.g. memory's endpoint configs) don't
 * need to fake a source.
 */
export function gatewayAuthHeaders(
	credentials: Pick<GatewayCredentials, "token" | "organizationId">,
): Record<string, string> {
	const headers: Record<string, string> = {}
	if (credentials.token) headers.Authorization = `Bearer ${credentials.token}`
	if (credentials.organizationId) headers[GATEWAY_ORGANIZATION_HEADER] = credentials.organizationId
	return headers
}
