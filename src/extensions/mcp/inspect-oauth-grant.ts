/** Inspect one MCP server's OAuth grant; see docs/mcp-forget-grant.md for the shared consent budget. */

import { inspectMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth"
import {
	inspectMcpCredentialAccount,
	installKeyringRequireBridge,
	McpKeychainDeniedError,
	McpKeychainUnavailableError,
} from "./keyring-require-bridge.js"
import { unverifiableCredentialMessage } from "./probe.js"

/**
 * Presence-only view of a server's stored OAuth grant. Built for support
 * flows: it answers the questions that decide a re-auth bug's cause (which
 * URL the grant is bound to, whether a refresh token exists, when the access
 * token expires) without ever exposing token values.
 */
export interface InspectMcpOAuthGrantResult {
	/** False when no credential account exists for the server name. */
	found: boolean
	/** The URL the grant is bound to. A mismatch with the configured server URL is the classic stale-grant cause. */
	serverUrl?: string
	/** Populated when a tokens payload was readable; absent means client-info only or unreadable. */
	tokens?: {
		hasAccessToken: boolean
		hasRefreshToken: boolean
		/** Unix seconds, per the adapter's StoredTokens shape. */
		expiresAt?: number
		/** Seconds until access-token expiry; negative values mean it has already expired. */
		expiresInSec?: number
		scope?: string
	}
}

export interface InspectMcpOAuthGrantOptions {
	/** Epoch milliseconds; a seam so tests can pin expiresInSec. */
	now?: () => number
}

export function inspectMcpOAuthGrant(
	serverName: string,
	options: InspectMcpOAuthGrantOptions = {},
): InspectMcpOAuthGrantResult {
	const account = inspectMcpCredentialAccount(serverName)
	if (account.status === "absent") return { found: false }
	if (account.status === "unavailable") {
		throw new Error(unverifiableCredentialMessage(serverName, "inspect"))
	}
	const serverUrl = account.serverUrl
	const result: InspectMcpOAuthGrantResult = { found: true, ...(serverUrl === undefined ? {} : { serverUrl }) }
	if (serverUrl === undefined) return result
	// The adapter's token read goes through its own createRequire keyring load
	// and its own service name; the bridge remaps both to kimchi's — without
	// it the compiled binary cannot load the module at all, and the dev
	// runtime reads the legacy service, so tokens would never surface.
	installKeyringRequireBridge()
	const now = options.now ?? (() => Date.now())
	try {
		const status = inspectMcpOAuthTokensForUrl(serverName, serverUrl)
		if (status.status !== "present") return result
		const tokens = status.tokens
		const expiresAt = tokens.expiresAt
		result.tokens = {
			// Derive — never salvage — the value: a `present` read must never claim
			// a missing access token exists.
			hasAccessToken: typeof tokens.accessToken === "string" && tokens.accessToken.length > 0,
			hasRefreshToken: typeof tokens.refreshToken === "string" && tokens.refreshToken.length > 0,
			...(expiresAt === undefined ? {} : { expiresAt, expiresInSec: Math.floor(expiresAt - now() / 1000) }),
			...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
		}
	} catch (error) {
		// A consent denial or locked keychain is a reportable outcome, not an
		// unreadable entry: surface it with the documented reason mapping.
		if (error instanceof McpKeychainDeniedError || error instanceof McpKeychainUnavailableError) throw error
		// Tokens unreadable (corrupt entry, backend error): the account exists
		// and that alone is the reportable fact.
	}
	return result
}
