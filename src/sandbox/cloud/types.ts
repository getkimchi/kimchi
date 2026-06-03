export type WorkspaceStatus = "active" | "idle" | "completed"

export interface Workspace {
	id: string
	name: string
	createdAt: Date
	lastActivityAt: Date
	status: WorkspaceStatus
	host?: string
}

export interface WorkspaceCredentials {
	connectToken: string
	expiresAt: string
	wsUrl: string
	host: string
}

export interface AuthenticateOptions {
	/**
	 * Override the cloud API endpoint (used by tests). Resolution order:
	 * 1. this option
	 * 2. `KIMCHI_REMOTE_ENDPOINT` env-var (for dev / mock-server testing)
	 * 3. production default `https://app.kimchi.dev/api`
	 */
	endpoint?: string
	/**
	 * Override global fetch (used by tests).
	 */
	fetch?: typeof globalThis.fetch
	/**
	 * Git personal access token to forward to the workspace so it
	 * can push/pull on behalf of the user.
	 */
	gitToken?: string
}

export interface ListWorkspacesOptions extends AuthenticateOptions {
	signal?: AbortSignal
}

export interface WaitForWorkspaceReadyOptions {
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

export class RemoteAuthError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
	) {
		super(message)
		this.name = "RemoteAuthError"
	}
}

export class RemoteNetworkError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "RemoteNetworkError"
	}
}
