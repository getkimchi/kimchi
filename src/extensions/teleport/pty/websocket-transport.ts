import WebSocket from "ws"
import { ReconnectSupervisor } from "./reconnect-supervisor.js"

export type WebSocketStatus = "connecting" | "open" | "reconnecting" | "closed" | "fatal"

export interface WebSocketTransportOptions {
	url: string
	/**
	 * Returns the Bearer token used on the next connect attempt. Called once per
	 * `connect()` invocation, including each reconnect, so callers can swap in a
	 * freshly-exchanged JWT after expiry. May be sync or async.
	 */
	tokenProvider: () => string | Promise<string>
	reconnect?: boolean
	/** Override the default backoff sequence (ms). */
	reconnectDelays?: number[]
	/** Override the steady-state max delay (ms) once `reconnectDelays` is exhausted. */
	maxReconnectDelay?: number
	/** Override the total retry budget (ms) before giving up. */
	maxTotalRetryMs?: number
	/** Override the set of fatal close codes that bypass retry. */
	fatalCodes?: number[]

	onData?: (data: Uint8Array | string) => void
	onOpen?: () => void
	onClose?: () => void
	onError?: (err: Error) => void
	/** UI-facing connection state stream (banner, indicator, etc.). */
	onStatus?: (status: WebSocketStatus) => void
	/** Fired once per backoff wait, before the timer starts. */
	onReconnecting?: (attempt: number, delayMs: number) => void
	/** Fired when a reconnect attempt opens the socket. */
	onReconnected?: () => void
	/** Fired when a fatal close code lands, or the retry budget is exhausted. */
	onFatal?: (code: number, reason: string) => void
}

// Standard "abnormal closure" used to feed transient failures (e.g. token
// fetch error) into the supervisor without inventing our own code.
const ABNORMAL_CLOSURE = 1006

export class WebSocketTransport {
	url: string
	tokenProvider: () => string | Promise<string>
	reconnect: boolean
	onData: ((data: Uint8Array | string) => void) | null
	onOpen: (() => void) | null
	onClose: (() => void) | null
	onError: ((err: Error) => void) | null
	onStatus: ((status: WebSocketStatus) => void) | null
	onReconnecting: ((attempt: number, delayMs: number) => void) | null
	onReconnected: (() => void) | null
	onFatal: ((code: number, reason: string) => void) | null

	private _ws: WebSocket | null = null
	private _closed = false
	private _buffer: (string | ArrayBufferLike | ArrayBufferView)[] = []
	private _pendingResize: { rows: number; cols: number } | null = null
	private _supervisor: ReconnectSupervisor
	private _status: WebSocketStatus = "closed"
	private _reconnectInFlight = false

	constructor(options: WebSocketTransportOptions) {
		this.url = options.url
		this.tokenProvider = options.tokenProvider
		this.reconnect = options.reconnect !== false
		this.onData = options.onData ?? null
		this.onOpen = options.onOpen ?? null
		this.onClose = options.onClose ?? null
		this.onError = options.onError ?? null
		this.onStatus = options.onStatus ?? null
		this.onReconnecting = options.onReconnecting ?? null
		this.onReconnected = options.onReconnected ?? null
		this.onFatal = options.onFatal ?? null

		this._supervisor = new ReconnectSupervisor({
			delays: options.reconnectDelays,
			maxDelayMs: options.maxReconnectDelay,
			maxTotalRetryMs: options.maxTotalRetryMs,
			fatalCodes: options.fatalCodes,
			onReconnecting: (attempt, delayMs) => {
				this._reconnectInFlight = true
				this._setStatus("reconnecting")
				this.onReconnecting?.(attempt, delayMs)
			},
			onFatal: (code, reason) => {
				this._reconnectInFlight = false
				this._setStatus("fatal")
				this.onFatal?.(code, reason)
			},
			reconnect: () => {
				this.connect()
			},
		})
	}

	connect(): void {
		this._closed = false
		this._setStatus("connecting")

		const tokenOrPromise = this.tokenProvider()
		if (tokenOrPromise instanceof Promise) {
			tokenOrPromise.then(
				(token) => this._openSocket(token),
				(err) => this._handleTokenError(err),
			)
		} else {
			this._openSocket(tokenOrPromise)
		}
	}

	write(data: string | ArrayBufferLike | ArrayBufferView): void {
		if (this._ws && this._ws.readyState === WebSocket.OPEN) {
			const payload = data instanceof ArrayBuffer ? new Uint8Array(data) : data
			this._ws.send(payload as string | Buffer | ArrayBufferView)
		} else {
			this._buffer.push(data)
		}
	}

	close(): void {
		this._closed = true
		this._supervisor.cancel()
		this._setStatus("closed")
		this._ws?.close()
	}

	/**
	 * Drop any pending backoff timer and reconnect immediately. Used by the
	 * overlay's manual-retry action. Resets the supervisor's attempt counter
	 * (via notifyConnected) so subsequent failures use the full backoff
	 * sequence again, rather than continuing from a near-exhausted budget.
	 */
	forceRetry(): void {
		this._supervisor.notifyConnected()
		this._reconnectInFlight = false
		this.connect()
	}

	resize(rows: number, cols: number): void {
		this._pendingResize = { rows, cols }
		if (this._ws?.readyState === WebSocket.OPEN) {
			this._ws.send(Buffer.from(`\x1b[RESIZE:${cols};${rows}]`))
		}
	}

	get connected(): boolean {
		return this._ws !== null && this._ws.readyState === WebSocket.OPEN
	}

	get status(): WebSocketStatus {
		return this._status
	}

	private _openSocket(token: string): void {
		if (this._closed) return

		const ws = new WebSocket(this.url, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		})
		this._ws = ws

		ws.on("open", () => {
			const wasReconnecting = this._reconnectInFlight
			this._reconnectInFlight = false
			this._supervisor.notifyConnected()
			this._setStatus("open")
			this._flushBuffer()
			if (this._pendingResize) {
				const { rows, cols } = this._pendingResize
				ws.send(Buffer.from(`\x1b[RESIZE:${cols};${rows}]`))
			}
			this.onOpen?.()
			if (wasReconnecting) {
				this.onReconnected?.()
			}
		})

		ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
			if (!this.onData) return
			if (isBinary) {
				this.onData(new Uint8Array(data as Buffer))
			} else {
				this.onData(data.toString())
			}
		})

		ws.on("close", (code: number, reasonBuf: Buffer) => {
			const reason = reasonBuf?.toString?.() ?? ""
			this.onClose?.()
			if (this._closed || !this.reconnect) {
				this._setStatus("closed")
				return
			}
			this._supervisor.handleClose(code, reason)
		})

		ws.on("error", (err: Error) => {
			this.onError?.(err)
			this._ws?.close()
		})
	}

	private _handleTokenError(err: unknown): void {
		const error = err instanceof Error ? err : new Error(String(err))
		this.onError?.(error)
		if (this._closed || !this.reconnect) {
			this._setStatus("closed")
			return
		}
		this._supervisor.handleClose(ABNORMAL_CLOSURE, `token refresh failed: ${error.message}`)
	}

	private _flushBuffer(): void {
		const items = this._buffer.splice(0)
		for (const item of items) {
			this.write(item)
		}
	}

	private _setStatus(status: WebSocketStatus): void {
		if (this._status === status) return
		this._status = status
		this.onStatus?.(status)
	}
}
