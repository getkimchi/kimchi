import { type AuthenticateResponse, RemoteAuthError, RemoteNetworkError } from "./types.js"

export interface AuthenticateOptions {
	/**
	 * Override the remote endpoint (used by tests).  Resolution order:
	 * 1. this option
	 * 2. `KIMCHI_REMOTE_ENDPOINT` env-var (for dev / mock-server testing)
	 * 3. production default `https://app.kimchi.dev`
	 */
	endpoint?: string
	/**
	 * Override global fetch (used by tests).
	 */
	fetch?: typeof globalThis.fetch
}

function resolveEndpoint(options?: AuthenticateOptions): string {
	const fromEnv = process.env.KIMCHI_REMOTE_ENDPOINT
	return options?.endpoint ?? fromEnv ?? "https://app.kimchi.dev/api"
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	fetchImpl: typeof globalThis.fetch,
	ms = 30_000,
): Promise<Response> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), ms)
	try {
		return await fetchImpl(url, { ...init, signal: ctrl.signal })
	} finally {
		clearTimeout(timer)
	}
}

async function checkResponse(resp: Response, endpoint: string): Promise<void> {
	if (resp.ok) return

	const body = await resp.text().catch(() => "")
	switch (resp.status) {
		case 401:
			throw new RemoteAuthError(`Invalid API key - run 'kimchi setup' to authenticate: ${endpoint}`, 401)
		case 403:
			throw new RemoteAuthError(
				`Forbidden - your API key does not have permission to use remote sessions. ${endpoint}`,
				403,
			)
		case 404:
			throw new RemoteAuthError(`Session not found or endpoint not available. ${endpoint}`, 404)
		case 409:
			throw new RemoteAuthError(`Session conflict - another client may already own this session. ${endpoint}`, 409)
		default: {
			throw new RemoteNetworkError(`HTTP ${resp.status} from ${endpoint}${body ? `: ${body}` : ""}`)
		}
	}
}

export async function verifyApiKey(apiKey: string, options?: AuthenticateOptions): Promise<string> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/api-keys:verify`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		},
		fetchImpl,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	const orgId = data.organizationId
	if (typeof orgId !== "string") {
		throw new RemoteNetworkError(`Missing organizationId in verify response from ${endpoint}`)
	}

	return orgId
}

async function createOrUpdateSession(
	orgId: string,
	sessionId: string,
	apiKey: string,
	options?: AuthenticateOptions,
): Promise<{ uri: string }> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "PUT",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ description: "kimchi remote session" }),
		},
		fetchImpl,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	const uri = data.uri
	if (typeof uri !== "string") {
		throw new RemoteNetworkError(`Missing uri in session response from ${endpoint}`)
	}

	return { uri }
}

export async function exchangeSessionToken(
	apiKey: string,
	sessionId: string,
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
			body: JSON.stringify({ sessionId }),
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
	options?: AuthenticateOptions,
): Promise<AuthenticateResponse> {
	const fetchImpl = options?.fetch ?? globalThis.fetch

	try {
		const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })
		const { uri } = await createOrUpdateSession(orgId, sessionId, apiKey, { ...options, fetch: fetchImpl })
		const { token, expireTime } = await exchangeSessionToken(apiKey, sessionId, { ...options, fetch: fetchImpl })

		return {
			connectToken: token,
			expiresAt: expireTime,
			wsUrl: uri,
		}
	} catch (err) {
		if (err instanceof RemoteAuthError || err instanceof RemoteNetworkError) {
			throw err
		}
		throw new RemoteNetworkError(err instanceof Error ? err.message : String(err))
	}
}
