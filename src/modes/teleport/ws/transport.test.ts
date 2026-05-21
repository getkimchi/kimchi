import { describe, expect, it, vi } from "vitest"
import { WebSocketTransport } from "./transport.js"

// Mock close event object — avoids Node.js CloseEvent dependency (not available < v22).
class MockWebSocket {
	static CONNECTING = 0
	static OPEN = 1
	static CLOSING = 2
	static CLOSED = 3
	readyState = MockWebSocket.CONNECTING
	public url: string
	public constructorOpts?: { headers?: Record<string, string> }
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
			const evt = { type: "close", code: code ?? 1000, reason: reason ?? "" } as CloseEvent
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
	return installMockWSFactory(() => ws)
}

function installMockWSFactory(factory: (url: string) => MockWebSocket) {
	const OriginalWS = (globalThis as unknown as { WebSocket: unknown }).WebSocket
	const mockFn = vi.fn().mockImplementation((url: string, opts?: { headers?: Record<string, string> }) => {
		const ws = factory(url)
		ws.url = url
		ws.constructorOpts = opts
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

describe("WebSocketTransport.create", () => {
	it("passes headers to the WebSocket constructor", async () => {
		const ws = new MockWebSocket("")
		ws.readyState = MockWebSocket.OPEN
		const restore = installMockWS(ws)

		const transportPromise = WebSocketTransport.create("wss://test.com/ws", {
			Authorization: "Bearer tok-abc",
		})

		queueMicrotask(() => ws.dispatchEvent(new Event("open")))

		const transport = await transportPromise
		expect(ws.url).toBe("wss://test.com/ws")
		expect(ws.constructorOpts?.headers).toEqual({ Authorization: "Bearer tok-abc" })
		transport.close()
		restore()
	})

	it("assigns a unique id to each transport", async () => {
		const ws = new MockWebSocket("")
		ws.readyState = MockWebSocket.OPEN
		const restore = installMockWS(ws)

		const p = WebSocketTransport.create("wss://test.com/ws", {})
		queueMicrotask(() => ws.dispatchEvent(new Event("open")))
		const transport = await p

		expect(transport.id).toMatch(/^ws-\d+-[a-z0-9]+$/)
		transport.close()
		restore()
	})

	it("isConnected() returns true when open", async () => {
		const ws = new MockWebSocket("")
		ws.readyState = MockWebSocket.OPEN
		const restore = installMockWS(ws)

		const p = WebSocketTransport.create("wss://test.com/ws", {})
		queueMicrotask(() => ws.dispatchEvent(new Event("open")))
		const transport = await p

		expect(transport.isConnected()).toBe(true)
		transport.close()
		restore()
	})

	it("writes lines as individual WS text messages", async () => {
		const ws = new MockWebSocket("")
		ws.readyState = MockWebSocket.OPEN
		const restore = installMockWS(ws)

		const p = WebSocketTransport.create("wss://test.com/ws", {})
		queueMicrotask(() => ws.dispatchEvent(new Event("open")))
		const transport = await p

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

		const p = WebSocketTransport.create("wss://test.com/ws", {})
		queueMicrotask(() => ws.dispatchEvent(new Event("open")))
		const transport = await p

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

		const p = WebSocketTransport.create("wss://test.com/ws", {})
		queueMicrotask(() => ws.dispatchEvent(new Event("open")))
		const transport = await p

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

	it("resolves closed promise with typed CloseInfo", async () => {
		const ws = new MockWebSocket("")
		ws.readyState = MockWebSocket.OPEN
		const restore = installMockWS(ws)

		const p = WebSocketTransport.create("wss://test.com/ws", {})
		queueMicrotask(() => ws.dispatchEvent(new Event("open")))
		const transport = await p

		const closedPromise = transport.closed
		transport.close(4003, "SessionFinished")

		const result = await closedPromise
		expect(result.code).toBe(4003)
		expect(result.reason).toBe("SessionFinished")
		restore()
	})

	it("rejects when the handshake fails", async () => {
		const restore = installMockWSFactory(() => {
			const ws = new MockWebSocket("")
			queueMicrotask(() => {
				ws.readyState = MockWebSocket.CLOSED
				ws.dispatchEvent(new Event("close"))
			})
			return ws
		})

		await expect(WebSocketTransport.create("wss://test.com/ws", {})).rejects.toThrow()

		restore()
	})

	it("throws when no WebSocket implementation is available", async () => {
		const orig = (globalThis as unknown as { WebSocket: unknown }).WebSocket
		try {
			;(globalThis as unknown as { WebSocket: unknown }).WebSocket = undefined as unknown as typeof WebSocket
			await expect(WebSocketTransport.create("wss://test.com/ws", {})).rejects.toThrow(/WebSocket is not available/)
		} finally {
			;(globalThis as unknown as { WebSocket: unknown }).WebSocket = orig
		}
	})
})
