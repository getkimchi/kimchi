import { getMe as getMeShared } from "../../../api/me.js"
import { RemoteNetworkError } from "../types.js"
import { resolveEndpoint } from "./http.js"
import type { AuthenticateOptions, MeResponse } from "./types.js"
import { RemoteAuthError } from "./types.js"

export async function getMe(apiKey: string, options?: AuthenticateOptions): Promise<MeResponse> {
	const endpoint = resolveEndpoint(options)
	try {
		return await getMeShared(apiKey, {
			endpoint,
			fetch: options?.fetch,
		})
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		if (msg.includes("HTTP 401")) {
			throw new RemoteAuthError(`Invalid API key - run 'kimchi setup' to authenticate: ${endpoint}`, 401)
		}
		if (msg.includes("HTTP 403")) {
			throw new RemoteAuthError(
				`Forbidden - your API key does not have permission to use remote sessions. ${endpoint}`,
				403,
			)
		}
		if (msg.includes("HTTP 404")) {
			throw new RemoteAuthError(`Session not found or endpoint not available. ${endpoint}`, 404)
		}
		throw new RemoteNetworkError(msg)
	}
}
