import { authenticateRemoteSession } from "./auth.js"
import { RemoteRpcClient } from "./rpc-client.js"
import { createWebSocketTransport } from "./transport-ws.js"
import { RemoteNetworkError, WsCloseCode } from "./types.js"

export interface ReconnectSupervisorOptions {
	sessionId: string
	description: string
	apiKey: string
	endpoint?: string
}

const FATAL_CODES = [WsCloseCode.Normal, WsCloseCode.TakenOver, WsCloseCode.SessionFinished]

const MAX_TOTAL_RETRY_MS = 300_000

export class ReconnectSupervisor {
	private disposed = false
	private reconnecting = false
	private currentClient?: RemoteRpcClient
	private reconnectTimer?: ReturnType<typeof setTimeout>

	onClientChange?: (client: RemoteRpcClient) => void
	onReconnecting?: () => void
	onReconnected?: () => void
	onFatal?: (error: Error) => void

	constructor(private readonly options: ReconnectSupervisorOptions) {}

	async connect(): Promise<RemoteRpcClient> {
		const { connectToken, wsUrl } = await authenticateRemoteSession(
			this.options.sessionId,
			this.options.apiKey,
			this.options.description,
			{
				endpoint: this.options.endpoint,
			},
		)

		const transport = await createWebSocketTransport(wsUrl, connectToken)
		const client = new RemoteRpcClient(transport)
		this.currentClient = client

		// Start close monitor — access through the transport.closed property
		transport.closed
			.then(({ code }) => {
				this.onTransportClose(code ?? 1000)
			})
			.catch(() => {
				this.onTransportClose(WsCloseCode.Normal)
			})

		return client
	}

	private onTransportClose(code: number): void {
		if (this.disposed) return

		if (FATAL_CODES.includes(code)) {
			const msg =
				code === WsCloseCode.TakenOver
					? "Session was taken over by another client."
					: code === WsCloseCode.SessionFinished
						? "Session has finished."
						: "Connection closed."
			this.onFatal?.(new Error(msg))
			return
		}

		this.startReconnectLoop()
	}

	private startReconnectLoop(): void {
		if (this.reconnecting || this.disposed) return
		this.reconnecting = true
		this.onReconnecting?.()

		const startTime = Date.now()
		const delays = [1000, 2000, 4000, 8000, 16000]
		let attempt = 0

		const tryReconnect = async () => {
			if (this.disposed) return

			if (Date.now() - startTime > MAX_TOTAL_RETRY_MS) {
				this.onFatal?.(new RemoteNetworkError("Could not reconnect after 5 minutes."))
				this.reconnecting = false
				return
			}

			const delay = attempt < delays.length ? delays[attempt] : 30_000
			attempt++

			this.reconnectTimer = setTimeout(async () => {
				if (this.disposed) return
				try {
					const client = await this.connect()
					this.reconnecting = false
					this.onClientChange?.(client)
					this.onReconnected?.()
				} catch {
					tryReconnect()
				}
			}, delay)
		}

		tryReconnect()
	}

	dispose(): void {
		this.disposed = true
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		this.currentClient?.close(1000, "user quit")
	}
}
