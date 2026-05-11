import type { Transport } from "./types.js"

export async function createWebSocketTransport(wsUrl: string, connectToken: string): Promise<Transport> {
	const url = `${wsUrl}?token=${encodeURIComponent(connectToken)}`

	// biome-ignore lint/suspicious/noExplicitAny: accessing globalThis WebSocket
	const WS = (globalThis as any).WebSocket
	if (!WS) {
		throw new Error("WebSocket is not available. Node 22+ is required for --remote.")
	}

	const ws = new WS(url)

	let readableController: ReadableStreamDefaultController<Uint8Array>
	const encoder = new TextEncoder()

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			readableController = controller
			ws.addEventListener("message", (ev: MessageEvent) => {
				const line = typeof ev.data === "string" ? ev.data : String(ev.data)
				const chunk = encoder.encode(`${line}\n`)
				controller.enqueue(chunk)
			})
			ws.addEventListener("close", () => {
				controller.close()
			})
			ws.addEventListener("error", (err: ErrorEvent) => {
				controller.error(err.error ?? new Error("WebSocket error"))
			})
		},
		cancel() {
			if (ws.readyState !== WS.CLOSED && ws.readyState !== WS.CLOSING) {
				ws.close()
			}
		},
	})

	// Wait until the socket is open before resolving
	await new Promise<void>((resolve, reject) => {
		if (ws.readyState === WS.OPEN) {
			resolve()
			return
		}
		const onOpen = () => {
			cleanup()
			resolve()
		}
		const onError = (ev: ErrorEvent) => {
			cleanup()
			reject(new Error(`WebSocket connection failed: ${ev.error?.message ?? "unknown"}`))
		}
		const onClose = () => {
			cleanup()
			reject(new Error("WebSocket connection closed before opening"))
		}
		const cleanup = () => {
			ws.removeEventListener("open", onOpen)
			ws.removeEventListener("error", onError)
			ws.removeEventListener("close", onClose)
		}
		ws.addEventListener("open", onOpen, { once: true })
		ws.addEventListener("error", onError, { once: true })
		ws.addEventListener("close", onClose, { once: true })
	})

	let buffer = ""
	const decoder = new TextDecoder("utf-8", { fatal: false })

	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			buffer += decoder.decode(chunk, { stream: true })
			while (true) {
				const idx = buffer.indexOf("\n")
				if (idx === -1) break
				const line = buffer.slice(0, idx)
				buffer = buffer.slice(idx + 1)
				if (ws.readyState === WS.OPEN) {
					ws.send(line)
				}
			}
		},
		close() {
			if (buffer.length > 0 && ws.readyState === WS.OPEN) {
				ws.send(buffer)
			}
		},
	})

	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.addEventListener("close", (ev: CloseEvent) => {
			resolve({ code: ev.code, reason: ev.reason })
		})
	})

	return {
		readable,
		writable,
		closed,
		close(code?: number, reason?: string) {
			if (ws.readyState !== WS.CLOSED && ws.readyState !== WS.CLOSING) {
				ws.close(code, reason)
			}
		},
	}
}
