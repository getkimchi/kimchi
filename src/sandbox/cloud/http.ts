import type { AuthenticateOptions } from "./types.js"
import { RemoteAuthError, RemoteNetworkError, RemoteQuotaError } from "./types.js"

export function resolveEndpoint(options?: AuthenticateOptions): string {
	const fromEnv = process.env.KIMCHI_REMOTE_ENDPOINT
	return options?.endpoint ?? fromEnv ?? "https://app.kimchi.dev/api"
}

export async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	fetchImpl: typeof globalThis.fetch,
	ms = 30_000,
	externalSignal?: AbortSignal,
): Promise<Response> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), ms)
	const signal = externalSignal ? AbortSignal.any([ctrl.signal, externalSignal]) : ctrl.signal
	try {
		return await fetchImpl(url, { ...init, signal })
	} finally {
		clearTimeout(timer)
	}
}

export async function checkResponse(resp: Response, endpoint: string): Promise<void> {
	if (resp.ok) return

	const body = await resp.text().catch(() => "")
	switch (resp.status) {
		case 401:
			throw new RemoteAuthError(`Invalid API key - run 'kimchi setup' to authenticate: ${endpoint}`, 401)
		case 403:
			throw new RemoteAuthError(
				`Forbidden - your API key does not have permission to use remote workspaces. ${endpoint}`,
				403,
			)
		case 404:
			throw new RemoteAuthError(`Workspace not found or endpoint not available. ${endpoint}`, 404)
		case 409:
			throw new RemoteAuthError(`Workspace conflict - another client may already own this workspace. ${endpoint}`, 409)
		case 429: {
			// Quota-exceeded bodies look like
			// {"message":"quota exceeded: user CPU limit exceeded","fieldViolations":[]}.
			// Surface the server's reason without the raw URL/JSON dump — the
			// message below is final, user-facing text.
			const detail = parseQuotaDetail(body)
			if (detail !== undefined) {
				throw new RemoteQuotaError(`Unable to provision workspace: ${detail}`, 429)
			}
			throw new RemoteNetworkError(`HTTP ${resp.status} from ${endpoint}${body ? `: ${body}` : ""}`)
		}
		default: {
			throw new RemoteNetworkError(`HTTP ${resp.status} from ${endpoint}${body ? `: ${body}` : ""}`)
		}
	}
}

/**
 * Extract the human-readable reason from a 429 body. Returns undefined when
 * the body is not JSON with a "message" string (e.g. a plain rate-limit
 * response) — callers then fall back to the raw error. A leading
 * "quota exceeded: " prefix is redundant next to the friendly wrapper and
 * is stripped.
 */
function parseQuotaDetail(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { message?: unknown }
		if (typeof parsed.message !== "string" || parsed.message.length === 0) return undefined
		return parsed.message.replace(/^quota exceeded:\s*/i, "")
	} catch {
		return undefined
	}
}
