import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import { verifyApiKey } from "./keys.js"
import type { AuthenticateOptions, ListWorkspacesOptions, Workspace, WorkspaceStatus } from "./types.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"
import { normalizeWsUri } from "./uri.js"

const LIST_WORKSPACES_PAGE_LIMIT = 200
const LIST_WORKSPACES_PAGE_HARD_CAP = 10

export async function listWorkspaces(apiKey: string, options?: ListWorkspacesOptions): Promise<Workspace[]> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const signal = options?.signal

	try {
		const orgId = await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })

		const results: Workspace[] = []
		let cursor = ""

		for (let page = 0; page < LIST_WORKSPACES_PAGE_HARD_CAP; page++) {
			const params = new URLSearchParams()
			params.set("page.limit", String(LIST_WORKSPACES_PAGE_LIMIT))
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
				console.error(`listWorkspaces: non-JSON response from ${url}: ${bodyText.slice(0, 500)}`)
				throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
			}

			if (typeof data !== "object" || data === null) {
				throw new RemoteNetworkError(`Unexpected response shape from ${endpoint}`)
			}

			const items = (data as { items?: unknown }).items
			if (!Array.isArray(items)) {
				console.error(`listWorkspaces: missing items array from ${url}: ${bodyText.slice(0, 500)}`)
				throw new RemoteNetworkError(`Missing items array in list-workspaces response from ${endpoint}`)
			}

			for (const item of items) {
				results.push(mapWorkspace(item, endpoint))
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

export async function deleteWorkspace(
	orgId: string,
	workspaceId: string,
	apiKey: string,
	options?: AuthenticateOptions,
): Promise<void> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(workspaceId)}`
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

function mapWorkspace(raw: unknown, endpoint: string): Workspace {
	if (typeof raw !== "object" || raw === null) {
		throw new RemoteNetworkError(`Invalid workspace entry in list-workspaces response from ${endpoint}`)
	}
	const r = raw as Record<string, unknown>

	const id = r.id
	if (typeof id !== "string" || id.length === 0) {
		throw new RemoteNetworkError(`Missing workspace id in list-workspaces response from ${endpoint}`)
	}

	const createTime = r.createTime
	if (typeof createTime !== "string") {
		throw new RemoteNetworkError(`Missing createTime for workspace ${id} from ${endpoint}`)
	}
	const createdAt = new Date(createTime)
	if (Number.isNaN(createdAt.getTime())) {
		throw new RemoteNetworkError(`Invalid createTime "${createTime}" for workspace ${id} from ${endpoint}`)
	}

	const name = typeof r.description === "string" ? r.description : ""
	const status = mapWorkspaceStatus(r.status)

	let host: string | undefined
	if (typeof r.uri === "string") {
		try {
			host = normalizeWsUri(r.uri).host
		} catch {
			host = undefined
		}
	}

	// Server proto has no last_activity_time field yet — placeholder for v1.
	return {
		id,
		name,
		createdAt,
		lastActivityAt: createdAt,
		status,
		host,
	}
}

function mapWorkspaceStatus(raw: unknown): WorkspaceStatus {
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
