import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import type { AuthenticateOptions, VerifiedKey } from "./types.js"
import { RemoteNetworkError } from "./types.js"

export async function verifyApiKey(apiKey: string, options?: AuthenticateOptions): Promise<VerifiedKey> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/workspace-tokens:verifyKey`
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

	const organizationId = data.organizationId
	if (typeof organizationId !== "string" || organizationId.length === 0) {
		throw new RemoteNetworkError(`Missing organizationId in verify response from ${endpoint}`)
	}

	// The key owner's user id — the value the workspaces API filters on as `creatorId`.
	const userId = data.userId
	if (typeof userId !== "string" || userId.length === 0) {
		throw new RemoteNetworkError(`Missing userId in verify response from ${endpoint}`)
	}

	return { organizationId, userId }
}
