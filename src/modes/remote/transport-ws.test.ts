import { describe, expect, it, vi } from "vitest"
import { createWebSocketTransport } from "./transport-ws.js"

// Mock that mimics the native WebSocket event interface (addEventListener etc.)
class MockWebSocket {
	static CONNECTING = 0
	static OPEN = 1
	static CLOSING = 2
	static CLOSED = 3
	readyState = MockWebSocket.CONNECTING
	public url: string
	public sent: (string | Uint8Array)[] = []
	private listeners = new Map<string, Array<EventListenerOrEventListenerObject>>()

	constructor(url: string) {
		this.url = url
	}

	send(data: string | Uint8Array) {
		this.sent.push(data)
	}

	close(code?: number, reason?: string) {
		this.readyState = MockWebSocket.CLOSING
		queueMicrotask(() => {
			this.readyState = MockWebSocket.CLOSED
			const evt = new CloseEvent("close", {
				code: code ?? 1000,
				reason: reason ?? "",
			})
			this.dispatchEvent(evt)
		})
	}

	addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
		const list = this.listeners.get(type) ?? []
		list.push(listener)
		this.listeners.set(type, list)
	}

	removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
		const list = this.listeners.get(type)
		if (!list) return
		const idx = list.indexOf(listener)
		if (idx !== -1) list.splice(idx, 1)
	}

	dispatchEvent(event: Event) {
		const list = this.listeners.get(event.type) ?? []
		for (const h of list) {
			if (typeof h === "function") {
				h(event)
			} else {
				h.handleEvent?.(event)
			}
		}
	}
}

function installMockWS(ws: MockWebSocket) {
	const OriginalWS = (globalThis as unknown as { WebSocket: unknown }).WebSocket
	const mockFn = vi.fn().mockImplementation((url: string) => {
		ws.url = url
		return ws
	}) as unknown as typeof WebSocket
	;(mockFn as unknown as Record<string, number>).OPEN = MockWebSocket.OPEN
	;(mockFn as unknown as Record<string, number>).CLOSING = MockWebSocket.CLOSING
	;(mockFn as unknown as Record<string, number>).CLOSED = MockWebSocket.CLOSED
	;(mockFn as unknown as Record<string, number>).CONNECTING = MockWebSocket.CONNECTING
	;(globalThis as unknown as { WebSocket: unknown }).WebSocket = mockFn
	return () => {
		;(globalThis as unknown as { WebSocket: unknown }).WebSocket = OriginalWS
	}
}

describe("createWebSocketTransport", () => {
	it("appends token as query param", async () => {
		const ws = new MockWebSocket("")
		ws.readyState = MockWebSocket.OPEN
		const restore = installMockWS(ws)

		const transportPromise = createWebSocketTransport("wss://test.com/ws", "tok-abc")

		queueMicrotask(() => ws.dispatchEvent(new Event("open")))

		const transport = await transportPromise
		expect(ws.url).toBe("wss://test.com/ws?token=tok-abc")
		transport.close()
		restore()
	})

	it("writes lines as individual WS text messages", async () => {
		const ws = new MockWebSocket("")
		ws.readyState = MockWebSocket.OPEN
		const restore = installMockWS(ws)

		const transportPromise = createWebSocketTransport("wss://test.com/ws", "tok")
		queueMicrotask(() => ws.dispatchEvent(new Event("open")))
		const transport = await transportPromise

		const writer = transport.writable.getWriter()
		await writer.write(new TextEncoder().encode('{"type":"ping"}\n{"type":"pong"}\n'))
		writer.releaseLock()

		expect(ws.sent).toHaveLength(2)
		expect(ws.sent[0]).toBe('{"type":"ping"}')
		expect(ws.sent[1]).toBe('{"type":"pong"}')

		transport.close()
		restore()
	})

	it("buffers partial lines across writes", async () => {
		const ws = new MockWebSocket("")
		ws.readyState = MockWebSocket.OPEN
		const restore = installMockWS(ws)

		const transportPromise = createWebSocketTransport("wss://test.com/ws", "tok")
		queueMicrotask(() => ws.dispatchEvent(new Event("open")))
		const transport = await transportPromise

		const writer = transport.writable.getWriter()
		await writer.write(new TextEncoder().encode('{"type":"first"'))
		await writer.write(new TextEncoder().encode(',"ok":true}\n'))
		writer.releaseLock()

		expect(ws.sent).toHaveLength(1)
		expect(ws.sent[0]).toBe('{"type":"first","ok":true}')

		transport.close()
		restore()
	})

	it("emits each WS message with a trailing newline in readable", async () => {
		const ws = new MockWebSocket("")
		ws.readyState = MockWebSocket.OPEN
		const restore = installMockWS(ws)

		const transportPromise = createWebSocketTransport("wss://test.com/ws", "tok")
		queueMicrotask(() => ws.dispatchEvent(new Event("open")))
		const transport = await transportPromise

		const reader = transport.readable.getReader()

		queueMicrotask(() => {
			ws.dispatchEvent(new MessageEvent("message", { data: '{"event":"ping"}' }))
		})

		const { value, done } = await reader.read()
		expect(done).toBe(false)
		expect(new TextDecoder().decode(value).trim()).toBe('{"event":"ping"}')

		reader.releaseLock()
		transport.close()
		restore()
	})

	it("resolves closed promise with close code and reason", async () => {
		const ws = new MockWebSocket("")
		ws.readyState = MockWebSocket.OPEN
		const restore = installMockWS(ws)

		const transportPromise = createWebSocketTransport("wss://test.com/ws", "tok")
		queueMicrotask(() => ws.dispatchEvent(new Event("open")))
		const transport = await transportPromise

		const closedPromise = transport.closed
		transport.close(4003, "SessionFinished")

		const result = await closedPromise
		expect(result.code).toBe(4003)
		expect(result.reason).toBe("SessionFinished")
		restore()
	})
})
