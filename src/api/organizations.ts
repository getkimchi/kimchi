import { resolveEndpoints } from "../config.js"
import { fetchWithRetry } from "../utils/http.js"

export interface VerifyApiKeyResponse {
	organizationId: string
	userId: string
}

export interface Organization {
	id: string
	name: string
}

function resolveEndpoint(): string {
	// resolveEndpoints honours KIMCHI_REMOTE_ENDPOINT, then the configured region.
	return resolveEndpoints().platformApiUrl
}

/**
 * Verify the organization's API key. Returns the organization the key is
 * scoped to — the authoritative org for this credential (a user may belong
 * to many organizations, but an org-scoped key belongs to exactly one).
 */
export async function verifyApiKey(
	apiKey: string,
	options?: { fetch?: typeof globalThis.fetch },
): Promise<VerifyApiKeyResponse> {
	const endpoint = resolveEndpoint()
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/api-keys:verify`
	const resp = await fetchWithRetry(
		url,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
		},
		{ fetchImpl },
	)

	if (!resp.ok) {
		throw new Error(`POST ${url} failed with HTTP ${resp.status}`)
	}

	const data = await resp.json().catch(() => {
		throw new Error(`Unexpected non-JSON response from ${url}`)
	})

	if (typeof data?.organizationId !== "string" || data.organizationId.length === 0) {
		throw new Error(`Missing organizationId in api-keys:verify response from ${url}`)
	}

	return data as VerifyApiKeyResponse
}

/** Fetch organization by id. */
export async function getOrganization(
	apiKey: string,
	organizationId: string,
	options?: { fetch?: typeof globalThis.fetch },
): Promise<Organization> {
	const endpoint = resolveEndpoint()
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/v1/organizations/${encodeURIComponent(organizationId)}`
	const resp = await fetchWithRetry(
		url,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
		},
		{ fetchImpl },
	)

	if (!resp.ok) {
		throw new Error(`GET ${url} failed with HTTP ${resp.status}`)
	}

	const data = await resp.json().catch(() => {
		throw new Error(`Unexpected non-JSON response from ${url}`)
	})

	if (typeof data?.id !== "string" || data.id.length === 0) {
		throw new Error(`Missing id in organization response from ${url}`)
	}

	return data as Organization
}
