export interface MeResponse {
	id: string
	username?: string
	name?: string
	email?: string
}

export interface GetMeOptions {
	/** Override the API endpoint (defaults to KIMCHI_REMOTE_ENDPOINT or https://app.kimchi.dev/api). */
	endpoint?: string
	/** Override global fetch (used by tests). */
	fetch?: typeof globalThis.fetch
	/** Abort signal. */
	signal?: AbortSignal
}

function resolveEndpoint(options?: GetMeOptions): string {
	if (options?.endpoint) return options.endpoint
	const fromEnv = process.env.KIMCHI_REMOTE_ENDPOINT
	return fromEnv ?? "https://app.kimchi.dev/api"
}

/**
 * Fetch the authenticated user's profile from /v1/me.
 * Re-usable across teleport and telemetry — does not depend on teleport-specific types.
 */
export async function getMe(apiKey: string, options?: GetMeOptions): Promise<MeResponse> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/v1/me`
	const resp = await fetchImpl(url, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
		signal: options?.signal,
	})

	if (!resp.ok) {
		throw new Error(`GET ${url} failed with HTTP ${resp.status}`)
	}

	const data = await resp.json().catch(() => {
		throw new Error(`Unexpected non-JSON response from ${url}`)
	})

	if (typeof data?.id !== "string" || data.id.length === 0) {
		throw new Error(`Missing id in /v1/me response from ${url}`)
	}

	return data as MeResponse
}
