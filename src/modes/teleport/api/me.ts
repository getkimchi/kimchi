import { RemoteNetworkError } from "../types.js"
import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import type { AuthenticateOptions, MeResponse } from "./types.js"

export async function getMe(apiKey: string, options?: AuthenticateOptions): Promise<MeResponse> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/v1/me`
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
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	if (typeof data?.id !== "string" || data.id.length === 0) {
		throw new RemoteNetworkError(`Missing id in /v1/me response from ${endpoint}`)
	}

	return data as MeResponse
}
