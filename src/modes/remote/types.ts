export interface AuthenticateResponse {
	connectToken: string
	expiresAt: string
	wsUrl: string
	host: string
	port: number
}

export type RemoteSessionStatus = "active" | "idle" | "completed"

export interface RemoteSessionSummary {
	id: string
	name: string
	createdAt: Date
	lastActivityAt: Date
	status: RemoteSessionStatus
	hasConnectedClient: boolean
}

export const REMOTE_ENDPOINT = "https://app.kimchi.dev"

export enum WsCloseCode {
	Normal = 1000,
	TakenOver = 4002,
	SessionFinished = 4003,
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

/** Minimal AgentEvent shape — remote events have arbitrary shape per type */
export interface AgentEvent {
	type: string
	[key: string]: unknown
}

export interface RpcResponse {
	id?: string
	type?: string
	success: boolean
	data?: unknown
	error?: string
}

/**
 * Transport for NDJSON-RPC.  The readable stream yields lines of JSON.
 * The writable stream receives lines to send.
 */
export interface Transport {
	readonly readable: ReadableStream<Uint8Array>
	readonly writable: WritableStream<Uint8Array>
	close(code?: number, reason?: string): void
	readonly closed: Promise<{ code?: number; reason?: string }>
}
