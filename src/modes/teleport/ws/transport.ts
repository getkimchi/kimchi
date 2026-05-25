import type { CloseInfo, Transport, TransportFactory, TransportOptions } from "./types.js"
import { WebSocket } from "ws"

// ─── WebSocketTransport (class-based, per spec) ────────────────────────────

/**
 * A single WebSocket connection wrapped as a {@link Transport}.
 *
 * Use the static `create()` factory which resolves only after the WS handshake
 * completes, or inject a custom WebSocket constructor for testing.
 */
export class WebSocketTransport implements Transport {
  readonly id: string
  // biome-ignore lint/suspicious/noExplicitAny: WebSocket instance varies across runtimes
  private readonly ws: any
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  readonly closed: Promise<CloseInfo>

  // biome-ignore lint/suspicious/noExplicitAny: WebSocket constructor varies
  private constructor(ws: any, WS: any) {
    this.id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    this.ws = ws

    const encoder = new TextEncoder()

    this.readable = new ReadableStream<Uint8Array>({
      start(controller) {
        ws.addEventListener("message", (ev: MessageEvent) => {
          const line = typeof ev.data === "string" ? ev.data : String(ev.data)
          controller.enqueue(encoder.encode(`${line}\n`))
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

    let buffer = ""
    const decoder = new TextDecoder("utf-8", { fatal: false })

    this.writable = new WritableStream<Uint8Array>({
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

    this.closed = new Promise<CloseInfo>((resolve) => {
      ws.addEventListener("close", (ev: CloseEvent) => {
        resolve({ code: ev.code, reason: ev.reason })
      })
    })
  }

  close(code?: number, reason?: string): void {
    // biome-ignore lint/suspicious/noExplicitAny: WebSocket statics
    const WS = (this.ws as any).constructor ?? WebSocket
    if (this.ws.readyState !== WS.CLOSED && this.ws.readyState !== WS.CLOSING) {
      this.ws.close(code, reason)
    }
  }

  isConnected(): boolean {
    // biome-ignore lint/suspicious/noExplicitAny: WebSocket statics
    const WS = (this.ws as any).constructor ?? WebSocket
    return this.ws.readyState === WS.OPEN
  }

  /**
   * Create a connected transport. Resolves after the WS handshake succeeds.
   *
   * @param url    Full WebSocket URL (wss://…)
   * @param headers  Headers to send during the upgrade (Authorization, etc.)
   * @param WS     WebSocket constructor override (defaults to WebSocket)
   */
  static async create(
    url: string,
    headers: Record<string, string>,
    // biome-ignore lint/suspicious/noExplicitAny: injectable WebSocket constructor
    WS?: any,
  ): Promise<WebSocketTransport> {
    const Ctor = WS ?? WebSocket
    if (!Ctor) {
      throw new Error("WebSocket is not available. Node 22+ is required for --remote.")
    }
    const ws = new Ctor(url, { headers })

    const transport = new WebSocketTransport(ws, Ctor)

    // Wait for the socket to open before resolving
    await new Promise<void>((resolve, reject) => {
      if (ws.readyState === Ctor.OPEN) {
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

    return transport
  }
}

// ─── WebSocketTransportFactory ─────────────────────────────────────────────

/** TransportFactory implementation for WebSocket connections. */
export const webSocketTransportFactory: TransportFactory = {
  type: "websocket",
  async connect(url, headers) {
    return WebSocketTransport.create(url, headers)
  },
}
