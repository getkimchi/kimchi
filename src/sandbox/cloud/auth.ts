import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import { verifyApiKey } from "./keys.js"
import type { AuthenticateOptions, WorkspaceCredentials } from "./types.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"
import { normalizeWsUri } from "./uri.js"

/**
 * Three-step authentication flow:
 * 1. Verify API key → organizationId.
 * 2. Create or update workspace → get WebSocket URI.
 * 3. Exchange for workspace token → get JWT for WebSocket auth.
 */
export async function authenticateWorkspace(
	workspaceId: string,
	apiKey: string,
	description: string,
	options?: AuthenticateOptions,
): Promise<WorkspaceCredentials> {
	const fetchImpl = options?.fetch ?? globalThis.fetch

	try {
		const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })
		const workspace = await createOrUpdateWorkspace(orgId, workspaceId, apiKey, description, {
			...options,
			fetch: fetchImpl,
		})
		const { token, expireTime } = await exchangeWorkspaceToken(apiKey, workspaceId, {
			...options,
			fetch: fetchImpl,
		})

		const { wsUrl, host } = normalizeWsUri(workspace.uri)

		return {
			connectToken: token,
			expiresAt: expireTime,
			wsUrl,
			host,
		}
	} catch (err) {
		if (err instanceof RemoteAuthError || err instanceof RemoteNetworkError) {
			throw err
		}
		throw new RemoteNetworkError(err instanceof Error ? err.message : String(err))
	}
}

export async function createOrUpdateWorkspace(
	orgId: string,
	workspaceId: string,
	apiKey: string,
	description: string,
	options?: AuthenticateOptions,
): Promise<{ uri: string; description: string }> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(workspaceId)}`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "PUT",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				description,
				options: {
					agentApiKey: apiKey,
					...(options?.gitToken ? { gitToken: options.gitToken } : {}),
				},
			}),
		},
		fetchImpl,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	const uri = data.uri
	if (typeof uri !== "string") {
		throw new RemoteNetworkError(`Missing uri in workspace response from ${endpoint}`)
	}

	return { uri, description: typeof data.description === "string" ? data.description : description }
}

export async function exchangeWorkspaceToken(
	apiKey: string,
	workspaceId: string,
	options?: AuthenticateOptions,
): Promise<{ token: string; expireTime: string }> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/session-tokens:exchange`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sessionId: workspaceId }),
		},
		fetchImpl,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	const token = data.token
	const expireTime = data.expireTime
	if (typeof token !== "string") {
		throw new RemoteNetworkError(`Missing token in exchange response from ${endpoint}`)
	}

	return { token, expireTime: typeof expireTime === "string" ? expireTime : "" }
}
