import {
	type AuthenticateResponse,
	RemoteAuthError,
	RemoteNetworkError,
	type RemoteSessionStatus,
	type RemoteSessionSummary,
} from "./types.js"

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
	externalSignal?: AbortSignal,
): Promise<Response> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), ms)
	const signal = externalSignal ? AbortSignal.any([ctrl.signal, externalSignal]) : ctrl.signal
	try {
		return await fetchImpl(url, { ...init, signal })
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

async function verifyApiKey(apiKey: string, options?: AuthenticateOptions): Promise<string> {
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

async function exchangeSessionToken(
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

		const { wsUrl, host, port } = normalizeWsUri(uri)

		return {
			connectToken: token,
			expiresAt: expireTime,
			wsUrl,
			host,
			port,
		}
	} catch (err) {
		if (err instanceof RemoteAuthError || err instanceof RemoteNetworkError) {
			throw err
		}
		throw new RemoteNetworkError(err instanceof Error ? err.message : String(err))
	}
}

function normalizeWsUri(raw: string): { wsUrl: string; host: string; port: number } {
	const schemeMatch = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)
	if (schemeMatch && !/^wss?$/i.test(schemeMatch[1])) {
		throw new RemoteNetworkError(`Unexpected protocol "${schemeMatch[1]}:" in server URI: ${raw}`)
	}
	const withScheme = schemeMatch ? raw : `wss://${raw}`
	let url: URL
	try {
		url = new URL(withScheme)
	} catch {
		throw new RemoteNetworkError(`Invalid WebSocket URI from server: ${raw}`)
	}
	if (url.protocol !== "wss:" && url.protocol !== "ws:") {
		throw new RemoteNetworkError(`Unexpected protocol "${url.protocol}" in server URI: ${raw}`)
	}
	const defaultPort = url.protocol === "wss:" ? 443 : 80
	const port = url.port ? Number(url.port) : defaultPort
	if (!Number.isFinite(port) || port <= 0) {
		throw new RemoteNetworkError(`Invalid port in WebSocket URI: ${raw}`)
	}
	const portStr = url.port && Number(url.port) !== defaultPort ? `:${url.port}` : ""
	const pathStr = url.pathname && url.pathname !== "/" ? url.pathname : ""
	return {
		wsUrl: `${url.protocol}//${url.hostname}${portStr}${pathStr}`,
		host: url.hostname,
		port,
	}
}

export interface ListRemoteSessionsOptions extends AuthenticateOptions {
	signal?: AbortSignal
}

const LIST_SESSIONS_PAGE_LIMIT = 200
const LIST_SESSIONS_PAGE_HARD_CAP = 10

export async function listRemoteSessions(
	apiKey: string,
	options?: ListRemoteSessionsOptions,
): Promise<RemoteSessionSummary[]> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const signal = options?.signal

	try {
		const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })

		const results: RemoteSessionSummary[] = []
		let cursor = ""

		for (let page = 0; page < LIST_SESSIONS_PAGE_HARD_CAP; page++) {
			const params = new URLSearchParams()
			params.set("page.limit", String(LIST_SESSIONS_PAGE_LIMIT))
			if (cursor) params.set("page.cursor", cursor)

			const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/sessions?${params.toString()}`
			const resp = await fetchWithTimeout(
				url,
				{
					method: "GET",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						Accept: "application/json",
					},
				},
				fetchImpl,
				30_000,
				signal,
			)

			await checkResponse(resp, url)

			const bodyText = await resp.text()
			let data: unknown
			try {
				data = JSON.parse(bodyText)
			} catch {
				console.error(`listRemoteSessions: non-JSON response from ${url}: ${bodyText.slice(0, 500)}`)
				throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
			}

			if (typeof data !== "object" || data === null) {
				throw new RemoteNetworkError(`Unexpected response shape from ${endpoint}`)
			}

			const items = (data as { items?: unknown }).items
			if (!Array.isArray(items)) {
				console.error(`listRemoteSessions: missing items array from ${url}: ${bodyText.slice(0, 500)}`)
				throw new RemoteNetworkError(`Missing items array in list-sessions response from ${endpoint}`)
			}

			for (const item of items) {
				results.push(mapSessionToSummary(item, endpoint))
			}

			const nextCursor = (data as { nextPageCursor?: unknown }).nextPageCursor
			if (typeof nextCursor !== "string" || nextCursor.length === 0) {
				return results
			}
			cursor = nextCursor
		}

		return results
	} catch (err) {
		if (err instanceof RemoteAuthError || err instanceof RemoteNetworkError) {
			throw err
		}
		throw new RemoteNetworkError(err instanceof Error ? err.message : String(err))
	}
}

function mapSessionToSummary(raw: unknown, endpoint: string): RemoteSessionSummary {
	if (typeof raw !== "object" || raw === null) {
		throw new RemoteNetworkError(`Invalid session entry in list-sessions response from ${endpoint}`)
	}
	const r = raw as Record<string, unknown>

	const id = r.id
	if (typeof id !== "string" || id.length === 0) {
		throw new RemoteNetworkError(`Missing session id in list-sessions response from ${endpoint}`)
	}

	const createTime = r.createTime
	if (typeof createTime !== "string") {
		throw new RemoteNetworkError(`Missing createTime for session ${id} from ${endpoint}`)
	}
	const createdAt = new Date(createTime)
	if (Number.isNaN(createdAt.getTime())) {
		throw new RemoteNetworkError(`Invalid createTime "${createTime}" for session ${id} from ${endpoint}`)
	}

	const name = typeof r.description === "string" ? r.description : ""
	const status = mapSessionStatus(r.status)

	// Server proto has no last_activity_time / has_connected_client fields yet — placeholder for v1.
	return {
		id,
		name,
		createdAt,
		lastActivityAt: createdAt,
		status,
		hasConnectedClient: false,
	}
}

function mapSessionStatus(raw: unknown): RemoteSessionStatus {
	switch (raw) {
		case "ACTIVE":
		case "INITIALIZING":
			return "active"
		case "DELETING":
			return "completed"
		default:
			return "idle"
	}
}
