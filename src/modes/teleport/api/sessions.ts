import { RemoteNetworkError, type RemoteSessionStatus, type RemoteSessionSummary } from "../types.js"
import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import { verifyApiKey } from "./keys.js"
import type { AuthenticateOptions, ListRemoteSessionsOptions } from "./types.js"
import { RemoteAuthError } from "./types.js"
import { normalizeWsUri } from "./uri.js"

export async function createOrUpdateSession(
	orgId: string,
	sessionId: string,
	apiKey: string,
	description: string,
	options?: AuthenticateOptions,
): Promise<{ uri: string; description: string }> {
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
		throw new RemoteNetworkError(`Missing uri in session response from ${endpoint}`)
	}

	return { uri, description: typeof data.description === "string" ? data.description : description }
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

const LIST_SESSIONS_PAGE_LIMIT = 200
const LIST_SESSIONS_PAGE_HARD_CAP = 10

export async function listRemoteSessions(
	apiKey: string,
	options?: ListRemoteSessionsOptions,
): Promise<RemoteSessionSummary[]> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const signal = options?.signal
	const creatorId = options?.creatorId

	try {
		const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })

		const results: RemoteSessionSummary[] = []
		let cursor = ""

		for (let page = 0; page < LIST_SESSIONS_PAGE_HARD_CAP; page++) {
			const params = new URLSearchParams()
			params.set("page.limit", String(LIST_SESSIONS_PAGE_LIMIT))
			if (cursor) params.set("page.cursor", cursor)
			if (creatorId) params.set("creatorId", creatorId)

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

	let host: string | undefined
	if (typeof r.uri === "string") {
		try {
			host = normalizeWsUri(r.uri).host
		} catch {
			host = undefined
		}
	}

	// Server proto has no last_activity_time / has_connected_client fields yet — placeholder for v1.
	return {
		id,
		name,
		createdAt,
		lastActivityAt: createdAt,
		status,
		hasConnectedClient: false,
		host,
	}
}

export async function deleteRemoteSession(
	apiKey: string,
	sessionId: string,
	options?: AuthenticateOptions,
): Promise<void> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)

	const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "DELETE",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		},
		fetchImpl,
	)

	await checkResponse(resp, url)
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
