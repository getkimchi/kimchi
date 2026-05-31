import WebSocket from "ws"

export interface WebSocketTransportOptions {
	url: string
	tokenProvider: () => string
	reconnect?: boolean
	maxReconnectDelay?: number
	onData?: (data: Uint8Array | string) => void
	onOpen?: () => void
	onClose?: () => void
	onError?: (err: Error) => void
}

export class WebSocketTransport {
	url: string
	tokenProvider: () => string
	reconnect: boolean
	maxReconnectDelay: number
	onData: ((data: Uint8Array | string) => void) | null
	onOpen: (() => void) | null
	onClose: (() => void) | null
	onError: ((err: Error) => void) | null

	private _ws: WebSocket | null = null
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
	private _reconnectDelay = 1000
	private _closed = false
	private _buffer: (string | ArrayBufferLike | ArrayBufferView)[] = []
	private _pendingResize: { rows: number; cols: number } | null = null

	constructor(options: WebSocketTransportOptions) {
		this.url = options.url
		this.tokenProvider = options.tokenProvider
		this.reconnect = options.reconnect !== false
		this.maxReconnectDelay = options.maxReconnectDelay ?? 30000
		this.onData = options.onData ?? null
		this.onOpen = options.onOpen ?? null
		this.onClose = options.onClose ?? null
		this.onError = options.onError ?? null
	}

	connect(): void {
		const token = this.tokenProvider()
		this._closed = false
		// this._ws = new WebSocket(this.url, ["pty.v0", `bearer.${token}`])
		this._ws = new WebSocket(this.url, {
			headers: {
				Authorization: `Bearer ${token}`,
			},
		})

		this._ws.on("open", () => {
			this._reconnectDelay = 1000
			this._flushBuffer()
			if (this._pendingResize) {
				const { rows, cols } = this._pendingResize
				this._ws?.send(Buffer.from(`\x1b[RESIZE:${cols};${rows}]`))
			}
			this.onOpen?.()
		})

		this._ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
			if (!this.onData) return
			if (isBinary) {
				this.onData(new Uint8Array(data as Buffer))
			} else {
				this.onData(data.toString())
			}
		})

		this._ws.on("close", () => {
			this.onClose?.()
			if (this.reconnect && !this._closed) this._scheduleReconnect()
		})

		this._ws.on("error", (err: Error) => {
			this.onError?.(err)
			this._ws?.close()
		})
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
		if (this._reconnectTimer) clearTimeout(this._reconnectTimer)
		this._ws?.close()
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

	private _flushBuffer(): void {
		const items = this._buffer.splice(0)
		for (const item of items) {
			this.write(item)
		}
	}

	private _scheduleReconnect(): void {
		this._reconnectTimer = setTimeout(() => {
			this.connect()
		}, this._reconnectDelay)
		this._reconnectDelay = Math.min(this._reconnectDelay * 2, this.maxReconnectDelay)
	}
}
