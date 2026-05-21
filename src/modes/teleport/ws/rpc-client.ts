import type { RpcCommand, RpcEventListener, RpcResponse } from "@earendil-works/pi-coding-agent"
import type { CloseInfo, Transport } from "./types.js"

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

interface PendingRequest {
	resolve: (value: unknown) => void
	reject: (reason: Error) => void
	timer?: ReturnType<typeof setTimeout>
}

/** Options for constructing a {@link RemoteRpcClient}. */
export interface RpcClientOptions {
	/** Transport to communicate over. */
	transport: Transport
	/** Request timeout in ms. Default 60000. */
	requestTimeoutMs?: number
	/** Called when the underlying transport closes. */
	onDisconnect?: (info: CloseInfo) => void
}

/**
 * Minimal pi-mono RPC client over a generic Transport (instead of child_process
 * stdio).  Public method surface mirrors the parts of pi-mono's `RpcClient`
 * that the remote agent session needs: request id allocation, response
 * correlation via a `pendingRequests` map, per-request timeout, response-vs-
 * event line discrimination.
 *
 * Wire types (`RpcCommand`, `RpcResponse`, `RpcEventListener`) are imported
 * from pi-mono so this client is typechecked against the same protocol the
 * server emits — no duplicate schema.
 */
export class RemoteRpcClient {
	private requestSeq = 0
	private pendingRequests = new Map<string, PendingRequest>()
	private eventListeners = new Set<RpcEventListener>()
	private closing = false
	private writeQueue: Array<{
		line: string
		resolve: () => void
		reject: (err: Error) => void
	}> = []
	private writing = false
	private readonly transport: Transport
	private readonly requestTimeoutMs: number

	/**
	 * Create an RPC client.
	 *
	 * Accepts either a bare {@link Transport} (backward-compat) or a full
	 * {@link RpcClientOptions} object with configurable timeout and disconnect
	 * callback.
	 */
	constructor(transportOrOptions: Transport | RpcClientOptions) {
		if ("transport" in transportOrOptions && "id" in (transportOrOptions as RpcClientOptions).transport) {
			const opts = transportOrOptions as RpcClientOptions
			this.transport = opts.transport
			this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
			if (opts.onDisconnect) {
				this.transport.closed.then(opts.onDisconnect).catch(() => {})
			}
		} else {
			// Backward-compat: bare Transport argument
			this.transport = transportOrOptions as Transport
			this.requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
		}
		this.runReader()
	}

	get closed(): Promise<CloseInfo> {
		return this.transport.closed.then(({ code, reason }) => ({
			code: code ?? 1000,
			reason: reason ?? "",
		}))
	}

	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.add(listener)
		return () => {
			this.eventListeners.delete(listener)
		}
	}

	/**
	 * Send a command over the transport and resolve with the response `data`.
	 *
	 * `method` is the wire command type — see pi-mono's `RpcCommand` union for
	 * the supported values (`"prompt"`, `"abort"`, `"get_state"`, …).  We
	 * accept `string` here rather than the strict union because higher layers
	 * (`RemoteAgentSession`) sometimes forward methods the server understands
	 * but pi-mono's typed union does not enumerate (e.g. remote-only
	 * extensions).  Type safety for the standard methods is enforced where
	 * `RpcCommand` is consumed.
	 */
	async send<T = unknown>(method: RpcCommand["type"] | string, params: Record<string, unknown> = {}): Promise<T> {
		if (this.closing) {
			throw new Error("Connection is closing")
		}

		const id = `req_${++this.requestSeq}`
		const request = { id, type: method, ...params }
		const line = `${JSON.stringify(request)}\n`
		const timeoutMs = this.requestTimeoutMs

		const promise = new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingRequests.delete(id)
				reject(new Error(`Request ${id} timed out after ${timeoutMs}ms`))
			}, timeoutMs)

			this.pendingRequests.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer,
			})
		})

		await this.enqueueWrite(line)
		return promise
	}

	/** Send a fire-and-forget JSONL line without correlating to a response. */
	sendOneWay(payload: Record<string, unknown>): Promise<void> {
		return this.enqueueWrite(`${JSON.stringify(payload)}\n`)
	}

	close(code?: number, reason?: string): void {
		if (this.closing) return
		this.closing = true

		for (const [id, pending] of this.pendingRequests) {
			if (pending.timer) clearTimeout(pending.timer)
			pending.reject(new Error("Connection closed"))
			this.pendingRequests.delete(id)
		}

		this.transport.close(code, reason)
	}

	private enqueueWrite(line: string): Promise<void> {
		return new Promise((resolve, reject) => {
			this.writeQueue.push({ line, resolve, reject })
			void this.flushWrites()
		})
	}

	private async flushWrites(): Promise<void> {
		if (this.writing) return
		this.writing = true
		while (this.writeQueue.length > 0) {
			const item = this.writeQueue.shift()
			if (!item) continue
			const writer = this.transport.writable.getWriter()
			try {
				await writer.write(new TextEncoder().encode(item.line))
				item.resolve()
			} catch (err) {
				item.reject(err as Error)
			} finally {
				writer.releaseLock()
			}
		}
		this.writing = false
	}

	private async runReader(): Promise<void> {
		const decoder = new TextDecoder("utf-8", { fatal: false })
		let buffer = ""

		try {
			const reader = this.transport.readable.getReader()
			try {
				while (!this.closing) {
					const { done, value } = await reader.read()
					if (done) break

					buffer += decoder.decode(value, { stream: true })
					while (true) {
						const idx = buffer.indexOf("\n")
						if (idx === -1) break
						const line = buffer.slice(0, idx)
						buffer = buffer.slice(idx + 1)
						if (line.length > 0) {
							this.handleLine(line)
						}
					}
				}
			} finally {
				reader.releaseLock()
			}
		} catch {
			// reader error – treat as closed
		}
	}

	/**
	 * Discriminate response vs event:
	 *   - Responses carry `type === "response"` AND an `id` matching a pending
	 *     request.  pi-mono's RpcResponse union always sets `type: "response"`.
	 *   - Everything else is treated as an AgentEvent and broadcast to
	 *     listeners.
	 */
	private handleLine(line: string): void {
		let payload: unknown
		try {
			payload = JSON.parse(line)
		} catch {
			// ignore malformed lines
			return
		}

		if (payload === null || typeof payload !== "object") return

		const obj = payload as { id?: unknown; type?: unknown; success?: unknown; data?: unknown; error?: unknown }

		if (obj.type === "response" && typeof obj.id === "string") {
			const pending = this.pendingRequests.get(obj.id)
			if (!pending) return

			if (pending.timer) clearTimeout(pending.timer)
			this.pendingRequests.delete(obj.id)

			const resp = obj as RpcResponse
			if (resp.success) {
				pending.resolve("data" in resp ? resp.data : undefined)
			} else {
				pending.reject(new Error(resp.error ?? "Request failed"))
			}
			return
		}

		if (typeof obj.type === "string") {
			for (const listener of this.eventListeners) {
				try {
					// biome-ignore lint/suspicious/noExplicitAny: AgentEvent is a closed union; trust the wire.
					listener(obj as any)
				} catch {
					// protect against listener errors
				}
			}
		}
	}
}
