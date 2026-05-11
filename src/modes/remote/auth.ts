import {
	type AuthenticateResponse,
	REMOTE_ENDPOINT,
	RemoteAuthError,
	RemoteNetworkError,
	WIRE_PROTOCOL,
} from "./types.js"

const CLIENT_INFO = {
	version: "0.1.0",
	platform: `${process.platform}-${process.arch}`,
	wireProtocol: WIRE_PROTOCOL,
}

export interface AuthenticateOptions {
	endpoint?: string
	fetch?: typeof globalThis.fetch
}

/**
 * Resolve the remote endpoint. Precedence:
 * 1. explicit `options.endpoint`
 * 2. `KIMCHI_REMOTE_ENDPOINT` env-var (for dev / mock-server testing)
 * 3. production default `https://llm.kimchi.dev`
 */
function resolveEndpoint(explicit?: string): string {
	if (explicit) return explicit
	const fromEnv = process.env.KIMCHI_REMOTE_ENDPOINT
	if (fromEnv && fromEnv.length > 0) return fromEnv
	return REMOTE_ENDPOINT
}

/**
 * Authenticate a remote session, returning a short-lived connect token.
 */
export async function authenticateRemoteSession(
	sessionId: string,
	apiKey: string,
	options: AuthenticateOptions = {},
): Promise<AuthenticateResponse> {
	const endpoint = resolveEndpoint(options.endpoint)
	const fetchImpl = options.fetch ?? globalThis.fetch
	const url = `${endpoint}/v1/remote-sessions/${encodeURIComponent(sessionId)}:authenticate`

	let resp: Response
	try {
		resp = await fetchImpl(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ client: CLIENT_INFO }),
		})
	} catch {
		throw new RemoteNetworkError("Could not reach llm.kimchi.dev")
	}

	if (resp.status === 200) {
		const data = (await resp.json()) as AuthenticateResponse
		return data
	}

	if (resp.status === 401) {
		throw new RemoteAuthError("Invalid API key — run 'kimchi setup' to authenticate", 401)
	}
	if (resp.status === 403) {
		throw new RemoteAuthError("Your account does not have access to remote sessions", 403)
	}
	if (resp.status === 404) {
		throw new RemoteAuthError("Session not found", 404)
	}
	if (resp.status === 409) {
		throw new RemoteAuthError("Session is active on another client", 409)
	}

	const body = await resp.text().catch(() => "")
	throw new RemoteNetworkError(`Authentication failed (${resp.status}): ${body}`)
}
