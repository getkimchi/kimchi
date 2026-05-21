import { RemoteNetworkError } from "../types.js"
import { verifyApiKey } from "./keys.js"
import { createOrUpdateSession, exchangeSessionToken } from "./sessions.js"
import type { AuthenticateOptions, AuthenticateResponse } from "./types.js"
import { RemoteAuthError } from "./types.js"
import { normalizeWsUri } from "./uri.js"

/**
 * Three-step authentication flow:
 * 1. Verify API key → organizationId.
 * 2. Create or update session → get WebSocket URI.
 * 3. Exchange for session token → get JWT for WebSocket auth.
 *
 * Keeps the same {@link AuthenticateResponse} shape so reconnect.ts and
 * transport-ws.ts do not need to change.
 */
export async function authenticateRemoteSession(
	sessionId: string,
	apiKey: string,
	description: string,
	options?: AuthenticateOptions,
): Promise<AuthenticateResponse> {
	const fetchImpl = options?.fetch ?? globalThis.fetch

	try {
		const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })
		const session = await createOrUpdateSession(orgId, sessionId, apiKey, description, {
			...options,
			fetch: fetchImpl,
		})
		const { token, expireTime } = await exchangeSessionToken(apiKey, sessionId, { ...options, fetch: fetchImpl })

		const { wsUrl, host } = normalizeWsUri(session.uri)

		return {
			connectToken: token,
			expiresAt: expireTime,
			wsUrl,
			host,
			description: session.description,
		}
	} catch (err) {
		if (err instanceof RemoteAuthError || err instanceof RemoteNetworkError) {
			throw err
		}
		throw new RemoteNetworkError(err instanceof Error ? err.message : String(err))
	}
}
