/**
 * MCP OAuth Provider
 *
 * Implementation of the MCP SDK's OAuthClientProvider interface.
 * Handles OAuth client registration, token storage, and authorization redirection.
 */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"
import type {
	OAuthClientInformation,
	OAuthClientInformationFull,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import {
	clearAllCredentials,
	clearClientInfo,
	clearTokens,
	getAuthEntry,
	getAuthForUrl,
	type StoredClientInfo,
	type StoredTokens,
	updateClientInfo,
	updateCodeVerifier,
	updateOAuthState,
	updateTokens,
} from "./mcp-auth.js"

// Callback server configuration
const DEFAULT_OAUTH_CALLBACK_PORT = 19876
const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"

let configuredOAuthCallbackPort = DEFAULT_OAUTH_CALLBACK_PORT

if (process.env.MCP_OAUTH_CALLBACK_PORT) {
	const parsedPort = Number.parseInt(process.env.MCP_OAUTH_CALLBACK_PORT, 10)
	if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
		configuredOAuthCallbackPort = parsedPort
	}
}

let oauthCallbackPort = configuredOAuthCallbackPort

export function getConfiguredOAuthCallbackPort(): number {
	return configuredOAuthCallbackPort
}

export function getOAuthCallbackPort(): number {
	return oauthCallbackPort
}

export function setOAuthCallbackPort(port: number): void {
	oauthCallbackPort = port
}

/** Configuration options for OAuth */
export interface McpOAuthConfig {
	grantType?: "authorization_code" | "client_credentials"
	clientId?: string
	clientSecret?: string
	scope?: string
}

/** Callbacks for OAuth flow interactions */
export interface McpOAuthCallbacks {
	onRedirect: (url: URL) => void | Promise<void>
}

/**
 * OAuth provider implementation for MCP servers.
 * Implements the OAuthClientProvider interface from the MCP SDK.
 */
export class McpOAuthProvider implements OAuthClientProvider {
	constructor(
		private serverName: string,
		private serverUrl: string,
		private config: McpOAuthConfig,
		private callbacks: McpOAuthCallbacks,
	) {}

	private get usesClientCredentials(): boolean {
		return this.config.grantType === "client_credentials"
	}

	/**
	 * The redirect URL for OAuth callbacks.
	 * This must match the redirect_uri in client metadata.
	 */
	get redirectUrl(): string | undefined {
		if (this.usesClientCredentials) return undefined
		return `http://127.0.0.1:${getOAuthCallbackPort()}${OAUTH_CALLBACK_PATH}`
	}

	/**
	 * Client metadata for dynamic registration.
	 * Describes this client to the OAuth authorization server.
	 */
	get clientMetadata(): OAuthClientMetadata {
		if (this.usesClientCredentials) {
			return {
				client_name: "Pi Coding Agent",
				redirect_uris: [],
				grant_types: ["client_credentials"],
				token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
			}
		}

		const redirectUrl = this.redirectUrl
		if (!redirectUrl) {
			throw new Error("redirectUrl is required for authorization_code flow")
		}

		return {
			redirect_uris: [redirectUrl],
			client_name: "Pi Coding Agent",
			client_uri: "https://github.com/nicobailon/pi-mcp-adapter",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
		}
	}

	/**
	 * Get client information (for pre-registered or dynamically registered clients).
	 * Returns undefined if no client info exists or if the server URL has changed.
	 */
	async clientInformation(): Promise<OAuthClientInformation | undefined> {
		// Check config first (pre-registered client)
		if (this.config.clientId) {
			return {
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
			}
		}

		// Check stored client info (from dynamic registration)
		// Use getAuthForUrl to validate credentials are for the current server URL
		const entry = await getAuthForUrl(this.serverName, this.serverUrl)
		if (entry?.clientInfo) {
			// Check if client secret has expired
			if (entry.clientInfo.clientSecretExpiresAt && entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000) {
				return undefined
			}
			return {
				client_id: entry.clientInfo.clientId,
				client_secret: entry.clientInfo.clientSecret,
			}
		}

		// No client info or URL changed - will trigger dynamic registration
		return undefined
	}

	/**
	 * Save client information from dynamic registration.
	 */
	async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
		const clientInfo: StoredClientInfo = {
			clientId: info.client_id,
			clientSecret: info.client_secret,
			clientIdIssuedAt: info.client_id_issued_at,
			clientSecretExpiresAt: info.client_secret_expires_at,
		}
		updateClientInfo(this.serverName, clientInfo, this.serverUrl)
	}

	/**
	 * Get stored OAuth tokens.
	 * Returns undefined if no tokens exist or if the server URL has changed.
	 */
	async tokens(): Promise<OAuthTokens | undefined> {
		// Use getAuthForUrl to validate tokens are for the current server URL
		const entry = await getAuthForUrl(this.serverName, this.serverUrl)
		if (!entry?.tokens) return undefined

		return {
			access_token: entry.tokens.accessToken,
			token_type: "Bearer",
			refresh_token: entry.tokens.refreshToken,
			expires_in: entry.tokens.expiresAt
				? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
				: undefined,
			scope: entry.tokens.scope,
		}
	}

	/**
	 * Save OAuth tokens.
	 */
	async saveTokens(tokens: OAuthTokens): Promise<void> {
		const storedTokens: StoredTokens = {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
			scope: tokens.scope,
		}
		updateTokens(this.serverName, storedTokens, this.serverUrl)
	}

	/**
	 * Redirect the user to the authorization URL.
	 * This opens the browser for the user to authenticate.
	 */
	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		if (this.usesClientCredentials) {
			throw new Error("redirectToAuthorization is not used for client_credentials flow")
		}
		// URL is passed to callback, not logged (may contain sensitive params)
		await this.callbacks.onRedirect(authorizationUrl)
	}

	/**
	 * Save the PKCE code verifier.
	 */
	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		updateCodeVerifier(this.serverName, codeVerifier)
	}

	/**
	 * Get the stored PKCE code verifier.
	 * @throws Error if no code verifier is stored
	 */
	async codeVerifier(): Promise<string> {
		if (this.usesClientCredentials) {
			throw new Error("codeVerifier is not used for client_credentials flow")
		}
		const entry = await getAuthEntry(this.serverName)
		if (!entry?.codeVerifier) {
			throw new Error(`No code verifier saved for MCP server: ${this.serverName}`)
		}
		return entry.codeVerifier
	}

	/**
	 * Save the OAuth state parameter for CSRF protection.
	 */
	async saveState(state: string): Promise<void> {
		updateOAuthState(this.serverName, state)
	}

	/**
	 * Get the stored OAuth state parameter.
	 * @throws Error if no state is stored
	 */
	async state(): Promise<string> {
		if (this.usesClientCredentials) {
			throw new Error("state is not used for client_credentials flow")
		}
		const entry = await getAuthEntry(this.serverName)
		if (!entry?.oauthState) {
			throw new Error(`No OAuth state saved for MCP server: ${this.serverName}`)
		}
		return entry.oauthState
	}

	/**
	 * Invalidate credentials when authentication fails.
	 * Clears tokens, client info, or all credentials based on the type.
	 */
	async invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
		switch (type) {
			case "all":
				clearAllCredentials(this.serverName)
				break
			case "client":
				clearClientInfo(this.serverName)
				break
			case "tokens":
				clearTokens(this.serverName)
				break
		}
	}

	prepareTokenRequest(scope?: string): URLSearchParams | undefined {
		if (!this.usesClientCredentials) {
			return undefined
		}

		const params = new URLSearchParams({ grant_type: "client_credentials" })
		const requestedScope = scope ?? this.config.scope
		if (requestedScope) {
			params.set("scope", requestedScope)
		}
		return params
	}
}

export { DEFAULT_OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_PATH }
