import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import type { AuthenticateOptions } from "./types.js"
import { RemoteNetworkError } from "./types.js"

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
