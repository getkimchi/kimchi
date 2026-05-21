export enum WsCloseCode {
	Normal = 1000,
	TakenOver = 4002,
	SessionFinished = 4003,
}

/** Typed close information from a transport. */
export interface CloseInfo {
	code: number
	reason: string
}

/** Options for configuring transport behavior. */
export interface TransportOptions {
	/** Request timeout in ms. Default 60000. */
	requestTimeoutMs?: number
	/** Custom logger. Default stderr. */
	log?: (msg: string) => void
}

/**
 * Transport for NDJSON-RPC.  The readable stream yields lines of JSON.
 * The writable stream receives lines to send.
 */
export interface Transport {
	/** Unique transport ID for debugging. */
	readonly id: string
	/** Read side — yields data lines. */
	readonly readable: ReadableStream<Uint8Array>
	/** Write side — receives data lines. */
	readonly writable: WritableStream<Uint8Array>
	/** Promise that resolves when transport closes. */
	readonly closed: Promise<CloseInfo>
	/** Explicitly close the transport. */
	close(code?: number, reason?: string): void
	/** Check if transport is currently connected. */
	isConnected(): boolean
}

/**
 * Factory abstraction for creating transports. Enables pluggable transport
 * implementations (WebSocket, mock, etc.).
 */
export interface TransportFactory {
	/** Transport type identifier. */
	readonly type: string
	/** Create a connected transport. */
	connect(url: string, headers: Record<string, string>, options?: TransportOptions): Promise<Transport>
}

/**
 * Options for the reconnecting transport wrapper.
 */
export interface ReconnectingTransportOptions extends TransportOptions {
	/** Max total time to spend retrying. Default 60000. */
	maxRetryMs?: number
	/** Initial backoff. Default 1000. */
	initialDelayMs?: number
	/** Max backoff. Default 30000. */
	maxDelayMs?: number
}
