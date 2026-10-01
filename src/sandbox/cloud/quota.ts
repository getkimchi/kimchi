import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import { verifyApiKey } from "./keys.js"
import { parseInt64 } from "./parse.js"
import type { GetQuotaUsageOptions, QuotaUsage, ResourceUsage } from "./types.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

/**
 * Fetch org/user quota usage from the control plane
 * (`GET /ai-optimizer/v1beta/organizations/{org}/quotas:usage`).
 *
 * Follows the same auth/timeout/error pattern as `listWorkspaces`: resolves
 * the org id from the API key, sends bearer auth, and throws
 * RemoteAuthError/RemoteNetworkError on failure. Callers that can live
 * without the data should catch and degrade.
 */
export async function getQuotaUsage(apiKey: string, options?: GetQuotaUsageOptions): Promise<QuotaUsage> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const signal = options?.signal

	try {
		// Callers that already verified the key (e.g. /remote-sessions, which
		// caches orgId for its refresh loop) pass it through to skip the
		// duplicate verifyKey round-trip.
		const orgId = options?.orgId ?? (await verifyApiKey(apiKey, { ...options, fetch: fetchImpl }))

		const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/quotas:usage`
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

		let data: unknown
		try {
			data = JSON.parse(await resp.text())
		} catch {
			throw new RemoteNetworkError(`Unexpected non-JSON response from quota usage endpoint ${endpoint}`)
		}
		if (typeof data !== "object" || data === null) {
			throw new RemoteNetworkError(`Unexpected response shape from quota usage endpoint ${endpoint}`)
		}
		const r = data as Record<string, unknown>
		return {
			orgUsage: parseResourceUsage(r.orgUsage),
			userUsage: parseResourceUsage(r.userUsage),
		}
	} catch (err) {
		if (err instanceof RemoteAuthError || err instanceof RemoteNetworkError) {
			throw err
		}
		throw new RemoteNetworkError(err instanceof Error ? err.message : String(err))
	}
}

/** Parse one usage scope; absent or non-object scopes stay undefined. */
function parseResourceUsage(raw: unknown): ResourceUsage | undefined {
	if (typeof raw !== "object" || raw === null) return undefined
	const r = raw as Record<string, unknown>
	return {
		currentSandboxes: parseInt64(r.currentSandboxes),
		maxSandboxes: parseInt64(r.maxSandboxes),
		currentCpuMillicores: parseInt64(r.currentCpuMillicores),
		maxCpuMillicores: parseInt64(r.maxCpuMillicores),
		currentRamBytes: parseInt64(r.currentRamBytes),
		maxRamBytes: parseInt64(r.maxRamBytes),
		currentPvcSizeBytes: parseInt64(r.currentPvcSizeBytes),
		maxPvcSizeBytes: parseInt64(r.maxPvcSizeBytes),
	}
}
