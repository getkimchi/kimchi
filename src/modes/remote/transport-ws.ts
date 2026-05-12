import type { Transport } from "./types.js"

export interface WebSocketTransportOptions {
	/** Total time budget for retrying failed handshakes. Default 60_000 (1 minute). */
	maxRetryMs?: number
	/** Initial backoff between retries; doubles each attempt. Default 1000. */
	initialDelayMs?: number
	/** Sink for retry diagnostics. Defaults to writing to stderr. */
	log?: (msg: string) => void
	/** Override for HTTP status probing. Defaults to globalThis.fetch. */
	fetch?: typeof globalThis.fetch
}

const DEFAULT_MAX_RETRY_MS = 60_000
const DEFAULT_INITIAL_DELAY_MS = 1000

export async function createWebSocketTransport(
	wsUrl: string,
	connectToken: string,
	options: WebSocketTransportOptions = {},
): Promise<Transport> {
	const url = `${wsUrl}?token=${encodeURIComponent(connectToken)}`

	// biome-ignore lint/suspicious/noExplicitAny: accessing globalThis WebSocket
	const WS = (globalThis as any).WebSocket
	if (!WS) {
		throw new Error("WebSocket is not available. Node 22+ is required for --remote.")
	}

	const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS
	const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
	const log = options.log ?? ((msg: string) => process.stderr.write(`${msg}\n`))
	const fetchImpl = options.fetch ?? globalThis.fetch

	const startTime = Date.now()
	let attempt = 0
	let lastError: unknown

	while (true) {
		try {
			return await createTransportOnce(WS, url)
		} catch (err) {
			lastError = err
			const elapsed = Date.now() - startTime
			if (elapsed >= maxRetryMs) break

			const status = await probeHttpStatus(url, fetchImpl)
			const statusInfo = status === undefined ? "" : ` (HTTP ${status})`
			const reason = err instanceof Error ? err.message : String(err)
			log(`kimchi: WebSocket handshake failed${statusInfo}: ${reason} — retrying...`)

			const delay = Math.min(initialDelayMs * 2 ** attempt, maxRetryMs - elapsed)
			attempt++
			if (delay > 0) await sleep(delay)
		}
	}

	throw lastError instanceof Error ? lastError : new Error(`WebSocket connection failed after ${maxRetryMs}ms`)
}

async function createTransportOnce(
	// biome-ignore lint/suspicious/noExplicitAny: WebSocket constructor varies
	WS: any,
	url: string,
): Promise<Transport> {
	const ws = new WS(url)

	const encoder = new TextEncoder()

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			ws.addEventListener("message", (ev: MessageEvent) => {
				const line = typeof ev.data === "string" ? ev.data : String(ev.data)
				const chunk = encoder.encode(`${line}\n`)
				controller.enqueue(chunk)
			})
			ws.addEventListener("close", () => {
				try {
					controller.close()
				} catch {
					// stream already closed/errored
				}
			})
			ws.addEventListener("error", (err: ErrorEvent) => {
				try {
					controller.error(err.error ?? new Error("WebSocket error"))
				} catch {
					// stream already closed/errored
				}
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

async function probeHttpStatus(wsUrl: string, fetchImpl: typeof globalThis.fetch): Promise<number | undefined> {
	const httpUrl = wsUrl.replace(/^ws/, "http")
	try {
		const ctrl = new AbortController()
		const timer = setTimeout(() => ctrl.abort(), 5_000)
		const resp = await fetchImpl(httpUrl, { method: "GET", signal: ctrl.signal })
		clearTimeout(timer)
		return resp.status
	} catch {
		return undefined
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}
