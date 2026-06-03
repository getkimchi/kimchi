import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebSocketTransport } from "./websocket-transport.js"

interface MockSocket {
	readyState: number
	handlers: Record<string, ((...args: unknown[]) => void)[]>
	send: ReturnType<typeof vi.fn>
	close: ReturnType<typeof vi.fn>
	url: string
	headers: Record<string, string>
}

let mockSockets: MockSocket[] = []

function currentSocket(): MockSocket {
	const ws = mockSockets[mockSockets.length - 1]
	if (!ws) throw new Error("no socket constructed yet")
	return ws
}

function fireHandlers(socket: MockSocket, event: string, ...args: unknown[]): void {
	for (const handler of socket.handlers[event] ?? []) {
		handler(...args)
	}
}

function openSocket(socket: MockSocket): void {
	socket.readyState = 1 // OPEN
	fireHandlers(socket, "open")
}

vi.mock("ws", () => ({
	default: class MockWebSocket {
		static CONNECTING = 0
		static OPEN = 1
		static CLOSING = 2
		static CLOSED = 3

		private socket: MockSocket

		constructor(url: string, opts?: { headers?: Record<string, string> }) {
			this.socket = {
				readyState: 0,
				handlers: {},
				send: vi.fn(),
				close: vi.fn(),
				url,
				headers: opts?.headers ?? {},
			}
			mockSockets.push(this.socket)
		}

		on(event: string, handler: (...args: unknown[]) => void): void {
			let list = this.socket.handlers[event]
			if (!list) {
				list = []
				this.socket.handlers[event] = list
			}
			list.push(handler)
		}

		get readyState(): number {
			return this.socket.readyState
		}

		send(...args: unknown[]): void {
			this.socket.send(...args)
		}

		close(): void {
			this.socket.close()
		}
	},
}))

beforeEach(() => {
	mockSockets = []
})

afterEach(() => {
	vi.useRealTimers()
})

describe("WebSocketTransport", () => {
	describe("resize", () => {
		it("buffers resize before the WebSocket is open", () => {
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "test-token",
			})

			transport.connect()
			transport.resize(30, 100)

			expect(currentSocket().send).not.toHaveBeenCalled()
		})

		it("sends buffered resize when the WebSocket opens", () => {
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "test-token",
			})

			transport.connect()
			transport.resize(30, 100)

			openSocket(currentSocket())

			expect(currentSocket().send).toHaveBeenCalledTimes(1)
			expect(currentSocket().send).toHaveBeenCalledWith(Buffer.from("\x1b[RESIZE:100;30]"))
		})

		it("sends resize directly when the WebSocket is already open", () => {
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "test-token",
			})

			transport.connect()
			openSocket(currentSocket())
			currentSocket().send.mockClear()

			transport.resize(40, 120)

			expect(currentSocket().send).toHaveBeenCalledTimes(1)
			expect(currentSocket().send).toHaveBeenCalledWith(Buffer.from("\x1b[RESIZE:120;40]"))
		})

		it("sends the latest resize on reconnection", () => {
			vi.useFakeTimers()
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "test-token",
				reconnectDelays: [10],
			})

			transport.connect()
			transport.resize(30, 100)

			openSocket(currentSocket())
			expect(currentSocket().send).toHaveBeenCalledWith(Buffer.from("\x1b[RESIZE:100;30]"))

			// drop the connection (transient code) and trigger backoff
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))

			// User resizes while disconnected; should be replayed on reconnect.
			transport.resize(50, 200)

			vi.advanceTimersByTime(10)
			openSocket(currentSocket())

			expect(currentSocket().send).toHaveBeenCalledWith(Buffer.from("\x1b[RESIZE:200;50]"))
		})
	})

	describe("auth header", () => {
		it("forwards the bearer token from tokenProvider", () => {
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "secret-token",
			})

			transport.connect()

			expect(currentSocket().headers.Authorization).toBe("Bearer secret-token")
		})

		it("awaits async tokenProviders before opening the socket", async () => {
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: async () => "async-token",
			})

			transport.connect()
			expect(mockSockets).toHaveLength(0)

			await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
			expect(currentSocket().headers.Authorization).toBe("Bearer async-token")
		})
	})

	describe("reconnect", () => {
		it("calls tokenProvider on every reconnect attempt with the latest value", () => {
			vi.useFakeTimers()
			let tokenN = 0
			const tokens: string[] = []
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => {
					tokenN++
					const t = `token-${tokenN}`
					tokens.push(t)
					return t
				},
				reconnectDelays: [10, 10, 10],
			})

			transport.connect()
			openSocket(currentSocket())

			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
			vi.advanceTimersByTime(10)
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
			vi.advanceTimersByTime(10)

			expect(tokens).toEqual(["token-1", "token-2", "token-3"])
			expect(mockSockets).toHaveLength(3)
			expect(mockSockets[1]?.headers.Authorization).toBe("Bearer token-2")
			expect(mockSockets[2]?.headers.Authorization).toBe("Bearer token-3")
		})

		it("follows the 1/2/4/8/16/30s backoff sequence", () => {
			vi.useFakeTimers()
			const delays: number[] = []
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "tok",
				onReconnecting: (_attempt, delayMs) => delays.push(delayMs),
			})

			transport.connect()
			openSocket(currentSocket())

			// Close 7 times to walk through 1s, 2s, 4s, 8s, 16s, 30s, 30s.
			for (let i = 0; i < 7; i++) {
				fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
				// Advance timer for whatever delay was just scheduled, so the
				// next connect/close cycle can proceed.
				const last = delays[delays.length - 1] ?? 0
				vi.advanceTimersByTime(last)
			}

			expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
		})

		it("gives up after the 5-minute retry budget and fires onFatal", () => {
			vi.useFakeTimers()
			const onFatal = vi.fn()
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "tok",
				// Use a tiny delay so we accumulate elapsed time via Date.now,
				// not by sitting through real 30s timers in the loop.
				reconnectDelays: [10],
				maxReconnectDelay: 10,
				maxTotalRetryMs: 100,
				onFatal,
			})

			transport.connect()
			openSocket(currentSocket())

			// First close starts the retry clock; advance past 100ms.
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
			vi.advanceTimersByTime(10)
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
			vi.advanceTimersByTime(200)
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))

			expect(onFatal).toHaveBeenCalledTimes(1)
			expect(onFatal.mock.calls[0]?.[0]).toBe(1006)
		})

		it("treats codes 1000, 4002, 4003 as fatal — no reconnect", () => {
			vi.useFakeTimers()

			for (const code of [1000, 4002, 4003]) {
				mockSockets = []
				const onFatal = vi.fn()
				const onReconnecting = vi.fn()
				const transport = new WebSocketTransport({
					url: "ws://example.com",
					tokenProvider: () => "tok",
					reconnectDelays: [10],
					onFatal,
					onReconnecting,
				})

				transport.connect()
				openSocket(currentSocket())
				fireHandlers(currentSocket(), "close", code, Buffer.from(""))

				vi.advanceTimersByTime(1000)

				expect(onReconnecting).not.toHaveBeenCalled()
				expect(onFatal).toHaveBeenCalledWith(code, expect.any(String))
				// Only the original socket was ever created.
				expect(mockSockets).toHaveLength(1)
			}
		})

		it("treats 4001 (auth failure) as fatal", () => {
			vi.useFakeTimers()
			const onFatal = vi.fn()
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "tok",
				reconnectDelays: [10],
				onFatal,
			})

			transport.connect()
			openSocket(currentSocket())
			fireHandlers(currentSocket(), "close", 4001, Buffer.from(""))

			vi.advanceTimersByTime(1000)
			expect(onFatal).toHaveBeenCalledWith(4001, expect.any(String))
			expect(mockSockets).toHaveLength(1)
		})

		it("fires onReconnected after a successful retry", () => {
			vi.useFakeTimers()
			const onReconnected = vi.fn()
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "tok",
				reconnectDelays: [10],
				onReconnected,
			})

			transport.connect()
			openSocket(currentSocket())
			expect(onReconnected).not.toHaveBeenCalled()

			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
			vi.advanceTimersByTime(10)
			openSocket(currentSocket())

			expect(onReconnected).toHaveBeenCalledTimes(1)
		})
	})

	describe("onStatus", () => {
		it("emits connecting → open → reconnecting → connecting → open across a drop", () => {
			vi.useFakeTimers()
			const statuses: string[] = []
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "tok",
				reconnectDelays: [10],
				onStatus: (s) => statuses.push(s),
			})

			transport.connect()
			openSocket(currentSocket())
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
			vi.advanceTimersByTime(10)
			openSocket(currentSocket())

			expect(statuses).toEqual(["connecting", "open", "reconnecting", "connecting", "open"])
		})

		it("emits 'closed' when the user calls close()", () => {
			const statuses: string[] = []
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "tok",
				onStatus: (s) => statuses.push(s),
			})

			transport.connect()
			openSocket(currentSocket())
			transport.close()

			expect(statuses).toEqual(["connecting", "open", "closed"])
		})

		it("emits 'fatal' on a fatal close code", () => {
			const statuses: string[] = []
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "tok",
				onStatus: (s) => statuses.push(s),
			})

			transport.connect()
			openSocket(currentSocket())
			fireHandlers(currentSocket(), "close", 4002, Buffer.from(""))

			expect(statuses).toEqual(["connecting", "open", "fatal"])
		})
	})

	describe("forceRetry", () => {
		it("cancels pending backoff and opens a fresh socket immediately", () => {
			vi.useFakeTimers()
			let tokenN = 0
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => `token-${++tokenN}`,
				// 60s backoff: long enough that the test fails if forceRetry doesn't
				// short-circuit it.
				reconnectDelays: [60_000],
			})

			transport.connect()
			openSocket(currentSocket())
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))

			// We're now waiting 60s. forceRetry should bypass the timer and
			// open a new socket with a fresh token.
			expect(mockSockets).toHaveLength(1)
			transport.forceRetry()
			expect(mockSockets).toHaveLength(2)
			expect(mockSockets[1]?.headers.Authorization).toBe("Bearer token-2")

			// Verify the original pending timer no longer fires a third connect.
			vi.advanceTimersByTime(60_000)
			expect(mockSockets).toHaveLength(2)
		})

		it("resets the supervisor's attempt counter so backoff restarts at 1s", () => {
			vi.useFakeTimers()
			const delays: number[] = []
			const transport = new WebSocketTransport({
				url: "ws://example.com",
				tokenProvider: () => "tok",
				onReconnecting: (_attempt, delayMs) => delays.push(delayMs),
			})

			transport.connect()
			openSocket(currentSocket())

			// Burn through 3 backoff steps (1s, 2s, 4s).
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
			vi.advanceTimersByTime(1000)
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
			vi.advanceTimersByTime(2000)
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
			vi.advanceTimersByTime(4000)
			expect(delays).toEqual([1000, 2000, 4000])

			// User retries; after the next drop, backoff should restart at 1s.
			transport.forceRetry()
			openSocket(currentSocket())
			fireHandlers(currentSocket(), "close", 1006, Buffer.from(""))
			expect(delays[delays.length - 1]).toBe(1000)
		})
	})
})
