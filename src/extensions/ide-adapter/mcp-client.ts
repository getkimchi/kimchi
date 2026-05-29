import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import WebSocket from "ws"
import type { IdeConnection, IdeTool, LockfileData } from "./types.js"

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10000

/** Minimal custom WebSocket transport that sends an auth header on handshake. */
class IdeWebSocketTransport implements Transport {
	private ws: WebSocket | null = null
	onclose?: () => void
	onerror?: (error: Error) => void
	onmessage?: (message: JSONRPCMessage) => void

	constructor(
		private url: URL,
		private authToken: string,
		private timeoutMs: number = DEFAULT_HANDSHAKE_TIMEOUT_MS,
	) {}

	start(): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false
			let timeoutId: ReturnType<typeof setTimeout> | null = null

			const clear = () => {
				if (timeoutId) {
					clearTimeout(timeoutId)
					timeoutId = null
				}
			}

			const onError = (event: unknown) => {
				clear()
				const err =
					event instanceof Error
						? event
						: typeof event === "object" && event !== null && "message" in event
							? new Error(String((event as { message: unknown }).message))
							: new Error(String(event))

				if (!settled) {
					settled = true
					reject(err)
				}
				this.onerror?.(err)
			}

			const onOpen = () => {
				clear()
				if (!settled) {
					settled = true
					resolve()
				}
			}

			timeoutId = setTimeout(() => {
				if (!settled) {
					settled = true
					reject(new Error(`WebSocket handshake to ${this.url} timed out after ${this.timeoutMs}ms`))
				}
				try {
					this.ws?.close()
				} catch {
					// ignore
				}
			}, this.timeoutMs)

			try {
				const urlWithToken = new URL(this.url.toString())
				urlWithToken.searchParams.set("token", this.authToken)
				this.ws = new WebSocket(urlWithToken)
			} catch (err) {
				clear()
				const error = err instanceof Error ? err : new Error(String(err))
				if (!settled) {
					settled = true
					reject(error)
				}
				this.onerror?.(error)
				return
			}

			// Use .on (persistent) so we catch every error event, not just the
			// first one.  Bun can emit a secondary unhandled ErrorEvent after the
			// primary error, and .once lets it crash the process.
			this.ws.on("error", onError)
			this.ws.once("open", onOpen)
			this.ws.on("close", () => this.onclose?.())
			this.ws.on("message", (data) => {
				try {
					const raw =
						typeof data === "string"
							? data
							: data instanceof Buffer || data instanceof Uint8Array
								? data.toString()
								: String(data)
					const message = JSON.parse(raw) as JSONRPCMessage
					this.onmessage?.(message)
				} catch (err) {
					this.onerror?.(err instanceof Error ? err : new Error(String(err)))
				}
			})
		})
	}

	async close(): Promise<void> {
		return new Promise((resolve) => {
			if (!this.ws) {
				resolve()
				return
			}
			if (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED) {
				resolve()
				return
			}
			this.ws.once("close", () => resolve())
			try {
				this.ws.close()
			} catch (_err) {
				resolve()
			}
		})
	}

	send(message: JSONRPCMessage): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				reject(new Error("WebSocket not open"))
				return
			}
			try {
				this.ws.send(JSON.stringify(message))
				resolve()
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)))
			}
		})
	}
}

export { IdeWebSocketTransport }

/** Open a WebSocket MCP connection to an IDE plugin.
 *
 * @returns IdeConnection with tool listing and calling helpers.
 * @throws on connection failure or initialization error.
 */
export async function connectToIde(lockfile: LockfileData): Promise<IdeConnection> {
	if (lockfile.transport !== "ws") {
		throw new Error(`Unsupported IDE transport "${lockfile.transport}" for ${lockfile.ideName}. Expected "ws".`)
	}

	const url = new URL(`ws://127.0.0.1:${lockfile.port}/mcp`)
	const transport = new IdeWebSocketTransport(url, lockfile.authToken)
	const client = new Client({ name: "kimchi-ide-adapter", version: "1.0.0" }, { capabilities: {} })

	try {
		await client.connect(transport)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		throw new Error(`Failed to connect to ${lockfile.ideName} at ${url} (port ${lockfile.port}): ${message}`)
	}

	// Subscribe to notifications so the transport stays responsive.
	// (The IdeConnection consumer can attach its own handlers if needed.)
	const conn: IdeConnection = {
		lockfile,
		close: async () => {
			// Prevent onDisconnect from firing during an intentional close
			transport.onclose = undefined
			await client.close()
			await transport.close()
		},
		listTools: async () => {
			const res = await client.listTools()
			return res.tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema,
			}))
		},
		callTool: async (name, args) => {
			const res = await client.callTool({ name, arguments: args as Record<string, unknown> | undefined })
			return res
		},
		setNotificationHandler: (handler: (msg: unknown) => void) => {
			const original = transport.onmessage
			transport.onmessage = (message) => {
				if (typeof message === "object" && message !== null && "method" in message && !("id" in message)) {
					handler(message)
				}
				original?.(message)
			}
		},
		onDisconnect: undefined,
	}

	// Wire unexpected close events so the consumer can null its handle and reconnect.
	const _onclose = transport.onclose
	transport.onclose = () => {
		_onclose?.()
		conn.onDisconnect?.()
	}

	return conn
}
