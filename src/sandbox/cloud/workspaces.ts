import { HARNESS_CLIENT_TYPE } from "../constants.js"
import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import { verifyApiKey } from "./keys.js"
import { parseInt64 } from "./parse.js"
import { byteQuantityToBytes, cpuQuantityToMillicores } from "./resources.js"
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
		// Callers that already verified the key (e.g. /remote-sessions, which
		// caches orgId for its refresh loop) pass it through to skip the
		// duplicate verifyKey round-trip.
		const orgId = options?.orgId ?? (await verifyApiKey(apiKey, { ...options, fetch: fetchImpl }))

		const results: Workspace[] = []
		let cursor = ""

		for (let page = 0; page < LIST_WORKSPACES_PAGE_HARD_CAP; page++) {
			const params = new URLSearchParams()
			params.set("page.limit", String(LIST_WORKSPACES_PAGE_LIMIT))
			params.set("clientType", HARNESS_CLIENT_TYPE)
			if (cursor) params.set("page.cursor", cursor)

			const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspaces?${params.toString()}`
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

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(workspaceId)}`
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

	// Resource requests (provisioned sizes), in both wire shapes the control
	// plane has used: current servers nest them under `resources` as
	// Kubernetes quantity strings ("200m", "512Mi", "10Gi") — the same shape
	// the client sends on create; the KAP-191 server flattens them to int64
	// fields (gRPC-gateway emits int64 as JSON strings). Explicit numbers win
	// when both shapes are present.
	const res = typeof r.resources === "object" && r.resources !== null ? r.resources : {}
	const resFields = res as Record<string, unknown>
	const cpuMillicores = parseInt64(r.cpuMillicores) ?? cpuQuantityToMillicores(resFields.cpu)
	const ramBytes = parseInt64(r.ramBytes) ?? byteQuantityToBytes(resFields.memory)
	const pvcSizeBytes = parseInt64(r.pvcSizeBytes) ?? byteQuantityToBytes(resFields.pvcSize)

	// Server proto has no last_activity_time field yet — placeholder for v1.
	return {
		id,
		name,
		createdAt,
		lastActivityAt: createdAt,
		status,
		host,
		cpuMillicores,
		ramBytes,
		pvcSizeBytes,
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
