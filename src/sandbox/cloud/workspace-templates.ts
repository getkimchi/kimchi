import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import { verifyApiKey } from "./keys.js"
import type {
	EgressPolicyConfig,
	ListWorkspaceTemplatesOptions,
	WorkspaceResourcesConfig,
	WorkspaceTemplateSpecPreview,
	WorkspaceTemplateSummary,
} from "./types.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

const LIST_TEMPLATES_PAGE_LIMIT = 200
const LIST_TEMPLATES_PAGE_HARD_CAP = 10

/**
 * List the organization's workspace templates
 * (`GET /ai-optimizer/v1beta/organizations/{org}/workspace-templates`).
 *
 * Follows the same auth/timeout/error/pagination pattern as `listWorkspaces`:
 * bearer auth, orgId passthrough to skip the verifyKey round-trip, cursor
 * pagination with a hard page cap, and typed errors. The picker only needs
 * id/name/description — the server expands the full template spec when a
 * workspace references the template by name at creation time, so the spec is
 * deliberately not mapped. Callers that can live without the catalog (the
 * setup dialog degrades to manual configuration) should catch and degrade.
 */
export async function listWorkspaceTemplates(
	apiKey: string,
	options?: ListWorkspaceTemplatesOptions,
): Promise<WorkspaceTemplateSummary[]> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const signal = options?.signal

	try {
		const orgId = options?.orgId ?? (await verifyApiKey(apiKey, { ...options, fetch: fetchImpl })).organizationId

		const results: WorkspaceTemplateSummary[] = []
		let cursor = ""

		for (let page = 0; page < LIST_TEMPLATES_PAGE_HARD_CAP; page++) {
			const params = new URLSearchParams()
			params.set("page.limit", String(LIST_TEMPLATES_PAGE_LIMIT))
			if (cursor) params.set("page.cursor", cursor)

			const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspace-templates?${params.toString()}`
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
				console.error(`listWorkspaceTemplates: non-JSON response from ${url}: ${bodyText.slice(0, 500)}`)
				throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
			}
			if (typeof data !== "object" || data === null) {
				throw new RemoteNetworkError(`Unexpected response shape from ${endpoint}`)
			}

			const items = (data as { items?: unknown }).items
			if (!Array.isArray(items)) {
				console.error(`listWorkspaceTemplates: missing items array from ${url}: ${bodyText.slice(0, 500)}`)
				throw new RemoteNetworkError(`Missing items array in list-workspace-templates response from ${endpoint}`)
			}
			for (const item of items) {
				const summary = mapTemplate(item, endpoint)
				if (summary) results.push(summary)
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

/**
 * Map one template entry. Catalog robustness: an entry without a usable
 * id/name is skipped (logged) rather than failing the whole listing — a
 * single malformed row must not block workspace creation.
 */
function mapTemplate(raw: unknown, endpoint: string): WorkspaceTemplateSummary | undefined {
	if (typeof raw !== "object" || raw === null) {
		console.error(`listWorkspaceTemplates: invalid template entry from ${endpoint}: skipped`)
		return undefined
	}
	const r = raw as Record<string, unknown>
	if (typeof r.id !== "string" || r.id.length === 0 || typeof r.name !== "string" || r.name.length === 0) {
		console.error(`listWorkspaceTemplates: template entry missing id/name from ${endpoint}: skipped`)
		return undefined
	}
	return {
		id: r.id,
		name: r.name,
		description: typeof r.description === "string" ? r.description : "",
		spec: mapSpecPreview(r.spec),
	}
}

/**
 * Map the template's preset parameters for read-only display in the setup
 * dialog. Section robustness: a malformed section is dropped (logged) rather
 * than failing the listing — the catalog is informational; the server
 * validates the template itself at creation time.
 */
function mapSpecPreview(raw: unknown): WorkspaceTemplateSpecPreview | undefined {
	if (typeof raw !== "object" || raw === null) return undefined
	const r = raw as Record<string, unknown>
	const resources = mapResourcesPreview(r.resources)
	const dependencies = mapStringArray(r.dependencies)
	const egressPolicy = mapEgressPolicyPreview(r.egressPolicy)
	if (!resources && !dependencies && !egressPolicy) return undefined
	return {
		...(resources ? { resources } : {}),
		...(dependencies ? { dependencies } : {}),
		...(egressPolicy ? { egressPolicy } : {}),
	}
}

function mapResourcesPreview(raw: unknown): WorkspaceResourcesConfig | undefined {
	if (typeof raw !== "object" || raw === null) return undefined
	const r = raw as Record<string, unknown>
	const out: WorkspaceResourcesConfig = {}
	for (const field of ["cpu", "memory", "pvcSize"] as const) {
		if (typeof r[field] === "string") out[field] = r[field] as string
	}
	return Object.keys(out).length > 0 ? out : undefined
}

function mapStringArray(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined
	const out = raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
	return out.length > 0 ? out : undefined
}

function mapEgressPolicyPreview(raw: unknown): EgressPolicyConfig | undefined {
	if (typeof raw !== "object" || raw === null) return undefined
	const r = raw as Record<string, unknown>
	const out: EgressPolicyConfig = {}
	if (typeof r.denyByDefault === "boolean") out.denyByDefault = r.denyByDefault
	const allowed = mapStringArray(r.allowed)
	const denied = mapStringArray(r.denied)
	if (allowed) out.allowed = allowed
	if (denied) out.denied = denied
	return Object.keys(out).length > 0 ? out : undefined
}
