export interface AuthenticateResponse {
	connectToken: string
	expiresAt: string
	wsUrl: string
	host: string
	description: string
}

export class RemoteAuthError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
	) {
		super(message)
		this.name = "RemoteAuthError"
	}
}

export interface AuthenticateOptions {
	/**
	 * Override the remote endpoint (used by tests).  Resolution order:
	 * 1. this option
	 * 2. `KIMCHI_REMOTE_ENDPOINT` env-var (for dev / mock-server testing)
	 * 3. production default `https://app.kimchi.dev`
	 */
	endpoint?: string
	/**
	 * Override global fetch (used by tests).
	 */
	fetch?: typeof globalThis.fetch
	/**
	 * Git personal access token to forward to the remote session so it
	 * can push/pull on behalf of the user.
	 */
	gitToken?: string
}

export interface MeResponse {
	id: string
	username?: string
	name?: string
	email?: string
}

export interface ListRemoteSessionsOptions extends AuthenticateOptions {
	signal?: AbortSignal
	creatorId?: string
}

export interface WaitForSessionReadyOptions {
	connectToken: string
	wsUrl: string
	signal?: AbortSignal
	timeoutMs?: number
	pollIntervalMs?: number
	probeTimeoutMs?: number
	wsPath?: string
	onTick?: (info: { elapsedMs: number; lastError?: string }) => void
	// biome-ignore lint/suspicious/noExplicitAny: tests inject a fake WebSocket constructor
	_WebSocket?: any
}
