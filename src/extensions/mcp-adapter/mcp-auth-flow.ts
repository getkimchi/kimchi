/**
 * MCP Auth Flow
 *
 * High-level OAuth flow management using the MCP SDK's built-in auth functions.
 * Follows the OpenCode pattern: let the SDK handle discovery internally via transport.
 */

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import open from "open"
import {
	clearAllCredentials,
	clearOAuthState,
	getAuthForUrl,
	getOAuthState,
	hasStoredTokens,
	isTokenExpired,
	type StoredTokens,
	updateOAuthState,
} from "./mcp-auth.js"
import {
	cancelPendingCallback,
	ensureCallbackServer,
	stopCallbackServer,
	waitForCallback,
} from "./mcp-callback-server.js"
import { type McpOAuthConfig, McpOAuthProvider } from "./mcp-oauth-provider.js"
import type { ServerEntry } from "./types.js"

/** Auth status for a server */
export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// Track pending transports for auth completion
const pendingTransports = new Map<string, StreamableHTTPClientTransport>()

// Deduplicate concurrent authenticate() calls per server.
const pendingAuthentications = new Map<string, Promise<AuthStatus>>()

/**
 * Generate a cryptographically secure random state parameter.
 */
function generateState(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
}

/**
 * Extract OAuth configuration from a ServerEntry.
 */
function extractOAuthConfig(definition: ServerEntry): McpOAuthConfig {
	// If oauth is explicitly false, return empty config
	if (definition.oauth === false) {
		return {}
	}
	return {
		grantType: definition.oauth?.grantType,
		clientId: definition.oauth?.clientId,
		clientSecret: definition.oauth?.clientSecret,
		scope: definition.oauth?.scope,
	}
}

/**
 * Start OAuth authentication flow for a server.
 * Returns the authorization URL that should be opened in a browser.
 *
 * This follows the OpenCode pattern:
 * 1. Create transport with auth provider
 * 2. Try to connect - SDK handles discovery internally
 * 3. If UnauthorizedError, capture the auth URL from onRedirect
 */
export async function startAuth(
	serverName: string,
	serverUrl: string,
	definition?: ServerEntry,
): Promise<{ authorizationUrl: string; transport: StreamableHTTPClientTransport }> {
	const config = definition ? extractOAuthConfig(definition) : {}

	if (config.grantType === "client_credentials") {
		const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
			onRedirect: async () => {
				throw new Error("Browser redirect is not used for client_credentials flow")
			},
		})
		const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
			authProvider,
		})
		const client = new Client({
			name: "pi-mcp",
			version: "3.0.0",
		})

		try {
			await client.connect(transport)
			return { authorizationUrl: "", transport }
		} finally {
			await client.close().catch(() => {})
			await transport.close().catch(() => {})
		}
	}

	// Start the callback server.
	// Pre-registered OAuth clients require an exact redirect URI, so enforce strict port binding.
	await ensureCallbackServer({ strictPort: Boolean(config.clientId) })

	// Generate and store OAuth state BEFORE creating the provider
	// The SDK will call provider.state() to read this value
	const oauthState = generateState()
	await updateOAuthState(serverName, oauthState)

	// Create the auth provider
	let capturedUrl: URL | undefined
	const authProvider = new McpOAuthProvider(serverName, serverUrl, config, {
		onRedirect: async (url) => {
			capturedUrl = url
		},
	})

	// Create transport with auth provider
	// The SDK handles OAuth discovery internally when connecting
	const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
		authProvider,
	})
	const client = new Client({
		name: "pi-mcp",
		version: "3.0.0",
	})

	// Try to connect - this triggers the OAuth flow
	try {
		await client.connect(transport)
		// If we get here, we're already authenticated
		await client.close().catch(() => {})
		await transport.close().catch(() => {})
		return { authorizationUrl: "", transport }
	} catch (error) {
		if (error instanceof UnauthorizedError && capturedUrl) {
			await client.close().catch(() => {})
			// Store transport for later finishAuth
			pendingTransports.set(serverName, transport)
			return { authorizationUrl: capturedUrl.toString(), transport }
		}
		await client.close().catch(() => {})
		await transport.close().catch(() => {})
		throw error
	}
}

/**
 * Complete OAuth authentication with the authorization code.
 */
export async function completeAuth(serverName: string, authorizationCode: string): Promise<AuthStatus> {
	const transport = pendingTransports.get(serverName)
	if (!transport) {
		throw new Error(`No pending OAuth flow for server: ${serverName}`)
	}

	try {
		// Complete the auth using the transport's finishAuth method
		await transport.finishAuth(authorizationCode)
		return "authenticated"
	} finally {
		pendingTransports.delete(serverName)
		await transport.close().catch(() => {})
	}
}

/**
 * Perform the complete OAuth authentication flow for a server.
 *
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server
 * @param definition - The server definition (optional)
 * @returns The final auth status
 */
export async function authenticate(
	serverName: string,
	serverUrl: string,
	definition?: ServerEntry,
): Promise<AuthStatus> {
	const inFlight = pendingAuthentications.get(serverName)
	if (inFlight) {
		return inFlight
	}

	const operation = (async (): Promise<AuthStatus> => {
		// Start auth flow
		const { authorizationUrl } = await startAuth(serverName, serverUrl, definition)

		// If no auth URL needed, already authenticated
		if (!authorizationUrl) {
			return "authenticated"
		}

		// Get the state that was already generated and stored in startAuth()
		const oauthState = await getOAuthState(serverName)
		if (!oauthState) {
			throw new Error("OAuth state not found - this should not happen")
		}

		// Register the callback BEFORE opening the browser
		const callbackPromise = waitForCallback(oauthState)

		// Open browser
		console.log(`MCP Auth: Opening browser for ${serverName}`)
		try {
			await open(authorizationUrl)
		} catch (error) {
			console.warn(`MCP Auth: Failed to open browser for ${serverName}`, { error })
			throw new Error(`Could not open browser. Please open this URL manually: ${authorizationUrl}`, { cause: error })
		}

		try {
			// Wait for callback
			const code = await callbackPromise

			// Validate state
			const storedState = await getOAuthState(serverName)
			if (storedState !== oauthState) {
				await clearOAuthState(serverName)
				throw new Error("OAuth state mismatch - potential CSRF attack")
			}
			await clearOAuthState(serverName)

			// Complete the auth
			return await completeAuth(serverName, code)
		} catch (error) {
			cancelPendingCallback(oauthState)
			const pendingTransport = pendingTransports.get(serverName)
			if (pendingTransport) {
				pendingTransports.delete(serverName)
				await pendingTransport.close().catch(() => {})
			}
			throw error
		}
	})()

	pendingAuthentications.set(serverName, operation)

	try {
		return await operation
	} finally {
		if (pendingAuthentications.get(serverName) === operation) {
			pendingAuthentications.delete(serverName)
		}
	}
}

/**
 * Get a valid access token for a server, refreshing if necessary.
 *
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server
 * @returns The valid tokens or null if not authenticated
 */
export async function getValidToken(serverName: string, serverUrl: string): Promise<StoredTokens | null> {
	// Check if we have valid tokens
	const entry = await getAuthForUrl(serverName, serverUrl)
	if (!entry?.tokens) {
		return null
	}

	// Check expiration
	const expired = await isTokenExpired(serverName)
	if (expired === false) {
		return entry.tokens
	}

	if (expired === true && entry.tokens.refreshToken) {
		// Token is expired, try to refresh
		console.log(`MCP Auth: Token expired for ${serverName}, attempting refresh`)

		try {
			// Create auth provider for token refresh
			const authProvider = new McpOAuthProvider(
				serverName,
				serverUrl,
				{},
				{
					onRedirect: async () => {},
				},
			)

			const clientInfo = await authProvider.clientInformation()
			if (!clientInfo) {
				console.log(`MCP Auth: No client info for refresh for ${serverName}`)
				return null
			}

			// Try to get tokens to find the token endpoint
			const existingTokens = await authProvider.tokens()
			if (!existingTokens) {
				return null
			}

			// Create transport to trigger refresh
			const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
				authProvider,
			})

			// Try to connect - SDK will attempt token refresh internally
			const client = new Client({ name: "pi-mcp", version: "3.0.0" })
			try {
				await client.connect(transport)
				// Get refreshed tokens
				const refreshed = await getAuthForUrl(serverName, serverUrl)
				return refreshed?.tokens ?? null
			} catch (error) {
				console.error(`MCP Auth: Token refresh failed for ${serverName}`, { error })
				return null
			} finally {
				await client.close().catch(() => {})
				await transport.close().catch(() => {})
			}
		} catch (error) {
			console.error(`MCP Auth: Token refresh failed for ${serverName}`, { error })
			return null
		}
	}

	// No expiration info or no refresh token, assume valid
	return entry.tokens
}

/**
 * Check the authentication status for a server.
 *
 * @param serverName - The name of the MCP server
 * @returns The current auth status
 */
export async function getAuthStatus(serverName: string): Promise<AuthStatus> {
	const hasTokens = await hasStoredTokens(serverName)
	if (!hasTokens) return "not_authenticated"

	const expired = await isTokenExpired(serverName)
	return expired ? "expired" : "authenticated"
}

/**
 * Remove all OAuth credentials for a server.
 *
 * @param serverName - The name of the MCP server
 */
export async function removeAuth(serverName: string): Promise<void> {
	const oauthState = await getOAuthState(serverName)
	if (oauthState) {
		cancelPendingCallback(oauthState)
	}
	const pendingTransport = pendingTransports.get(serverName)
	if (pendingTransport) {
		pendingTransports.delete(serverName)
		await pendingTransport.close().catch(() => {})
	}
	clearAllCredentials(serverName)
	await clearOAuthState(serverName)
	console.log(`MCP Auth: Removed credentials for ${serverName}`)
}

/**
 * Check if OAuth is supported for a server configuration.
 * OAuth is supported for HTTP servers unless explicitly disabled.
 *
 * @param definition - The server definition
 * @returns True if OAuth is supported
 */
export function supportsOAuth(definition: ServerEntry): boolean {
	// OAuth requires a URL
	if (!definition.url) return false

	// Explicitly disabled via auth: false or oauth: false
	if (definition.auth === false) return false
	if (definition.oauth === false) return false

	// OAuth is enabled if auth is 'oauth' or not specified (auto-detect)
	return definition.auth === "oauth" || definition.auth === undefined
}

/**
 * Initialize the OAuth system on startup.
 * Starts the callback server if there are any OAuth servers configured.
 */
export async function initializeOAuth(): Promise<void> {
	await ensureCallbackServer()
}

/**
 * Shutdown the OAuth system.
 * Stops the callback server and cancels pending auths.
 */
export async function shutdownOAuth(): Promise<void> {
	await stopCallbackServer()
}
