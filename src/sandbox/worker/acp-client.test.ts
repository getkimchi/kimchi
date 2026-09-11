import { PROTOCOL_VERSION, type SessionNotification } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	type AcpSessionCallbacks,
	AcpSessionClient,
	extractFinalAssistantText,
	RemoteConnectionError,
} from "./acp-client.js"

// ---------------------------------------------------------------------------
// Mock WebSocket — mirrors the pattern from websocket-transport.test.ts
// ---------------------------------------------------------------------------

interface MockSocket {
	readyState: number
	handlers: Record<string, ((...args: unknown[]) => void)[]>
	send: ReturnType<typeof vi.fn>
	close: ReturnType<typeof vi.fn>
	url: string
	headers: Record<string, string>
	binaryType?: string
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

const CONNECTING = 0
const OPEN = 1

/** Whether MockWebSocket.ping() auto-responds with pong. Set false to simulate a dead transport. */
let respondToPing = true

class MockWebSocket {
	static CONNECTING = CONNECTING
	static OPEN = OPEN
	static CLOSING = 2
	static CLOSED = 3

	private socket: MockSocket

	constructor(url: string, opts?: { headers?: Record<string, string> }) {
		this.socket = {
			readyState: CONNECTING,
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

	off(event: string, handler: (...args: unknown[]) => void): void {
		const list = this.socket.handlers[event]
		if (!list) return
		const idx = list.indexOf(handler)
		if (idx >= 0) list.splice(idx, 1)
	}

	get readyState(): number {
		return this.socket.readyState
	}

	get OPEN(): number {
		return OPEN
	}

	send(...args: unknown[]): void {
		this.socket.send(...args)
		// The real ws package calls the callback when data is flushed.
		// The AcpSessionClient passes (buffer, callback) — invoke it to unblock the WritableStream.
		const last = args[args.length - 1]
		if (typeof last === "function") {
			;(last as () => void)()
		}
	}

	ping(): void {
		// Simulate a real WS: auto-respond with pong so the keepalive
		// doesn't falsely detect a broken connection in tests.
		if (!respondToPing) return
		fireHandlers(this.socket, "pong")
	}

	close(): void {
		this.socket.readyState = 3 // CLOSED
		this.socket.close()
		fireHandlers(this.socket, "close")
	}

	set binaryType(v: string) {
		this.socket.binaryType = v
	}
}

// ---------------------------------------------------------------------------
// Helpers to simulate the remote agent (server side of ACP JSON-RPC)
// ---------------------------------------------------------------------------

/**
 * Extracts JSON-RPC messages sent by the client over the WebSocket.
 * Each `ws.send` call is a newline-delimited JSON message.
 */
function getSentMessages(socket: MockSocket): Record<string, unknown>[] {
	const messages: Record<string, unknown>[] = []
	for (const call of socket.send.mock.calls) {
		const raw = call[0]
		let str: string
		if (raw instanceof Buffer) str = raw.toString()
		else if (raw instanceof Uint8Array) str = new TextDecoder().decode(raw)
		else if (typeof raw === "string") str = raw
		else str = String(raw)

		for (const line of str.split("\n")) {
			const trimmed = line.trim()
			if (!trimmed) continue
			try {
				messages.push(JSON.parse(trimmed))
			} catch {
				// ignore non-JSON lines
			}
		}
	}
	return messages
}

/**
 * Sends a JSON-RPC message from the "server" (remote agent) to the client
 * by firing the WebSocket "message" handler with a newline-delimited JSON payload.
 */
function serverSendMessage(socket: MockSocket, msg: Record<string, unknown>): void {
	const payload = Buffer.from(`${JSON.stringify(msg)}\n`)
	fireHandlers(socket, "message", payload, false)
}

/** Builds a JSON-RPC response to a client request. */
function rpcResponse(id: string | number, result: unknown): Record<string, unknown> {
	return { jsonrpc: "2.0", id, result }
}

/** Builds a JSON-RPC notification from the server. */
function rpcNotification(method: string, params: unknown): Record<string, unknown> {
	return { jsonrpc: "2.0", method, params }
}

/** Finds the client request with the given method and returns its id + params. */
function findRequest(messages: Record<string, unknown>[], method: string): { id: string | number; params: unknown } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]
		if (m.method === method) {
			return { id: m.id as string | number, params: m.params }
		}
	}
	throw new Error(`No request with method "${method}" found in sent messages`)
}

// ---------------------------------------------------------------------------
// Test credentials
// ---------------------------------------------------------------------------

function makeCredentials() {
	return {
		connectToken: "test-token-123",
		expiresAt: new Date(Date.now() + 3600_000).toISOString(),
		wsUrl: "wss://worker.example.com",
		host: "worker.example.com",
	}
}

function makeCallbacks(): { callbacks: AcpSessionCallbacks; calls: ReturnType<typeof vi.fn>[] } {
	const calls: ReturnType<typeof vi.fn>[] = []
	const callbacks: AcpSessionCallbacks = {
		onTextDelta: vi.fn(),
		onToolActivity: vi.fn(),
		onTurnEnd: vi.fn(),
		onAssistantUsage: vi.fn(),
	}
	return { callbacks, calls }
}

/**
 * Initializes a client, simulating the server responding to initialize and newSession.
 * Returns the socket and the client.
 */
async function initClient(client: AcpSessionClient): Promise<{ socket: MockSocket }> {
	const initPromise = client.initialize()
	await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
	const socket = currentSocket()

	// The WebSocket must be open before the client sends any JSON-RPC messages.
	openSocket(socket)

	// Wait for the "initialize" request to arrive
	await vi.waitFor(() => {
		const sent = getSentMessages(socket)
		expect(sent.some((m) => m.method === "initialize")).toBe(true)
	})

	const initReq = findRequest(getSentMessages(socket), "initialize")
	serverSendMessage(socket, rpcResponse(initReq.id, { protocolVersion: PROTOCOL_VERSION }))

	await vi.waitFor(() => {
		const sent = getSentMessages(socket)
		expect(sent.some((m) => m.method === "session/new")).toBe(true)
	})

	const newSessionReq = findRequest(getSentMessages(socket), "session/new")
	serverSendMessage(socket, rpcResponse(newSessionReq.id, { sessionId: "session-abc" }))

	// The client sends a session/set_config_option request after newSession
	// to set the permission mode. Respond so initialize() can resolve.
	await vi.waitFor(() => {
		expect(getSentMessages(socket).some((m) => m.method === "session/set_config_option")).toBe(true)
	})
	const configReq = findRequest(getSentMessages(socket), "session/set_config_option")
	serverSendMessage(socket, rpcResponse(configReq.id, {}))

	await initPromise

	return { socket }
}

/** initialize() through the session/load path (options.sessionId set). */
async function initClientWithLoad(client: AcpSessionClient): Promise<{ socket: MockSocket }> {
	const initPromise = client.initialize()
	await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
	const socket = currentSocket()
	openSocket(socket)

	await vi.waitFor(() => {
		expect(getSentMessages(socket).some((m) => m.method === "initialize")).toBe(true)
	})
	const initReq = findRequest(getSentMessages(socket), "initialize")
	serverSendMessage(socket, rpcResponse(initReq.id, { protocolVersion: PROTOCOL_VERSION }))

	await vi.waitFor(() => {
		expect(getSentMessages(socket).some((m) => m.method === "session/load")).toBe(true)
	})
	const loadReq = findRequest(getSentMessages(socket), "session/load")
	serverSendMessage(socket, rpcResponse(loadReq.id, {}))

	await vi.waitFor(() => {
		expect(getSentMessages(socket).some((m) => m.method === "session/set_config_option")).toBe(true)
	})
	const configReq = findRequest(getSentMessages(socket), "session/set_config_option")
	serverSendMessage(socket, rpcResponse(configReq.id, {}))

	await initPromise
	return { socket }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	mockSockets = []
	respondToPing = true
})

afterEach(() => {
	vi.useRealTimers()
	mockSockets = []
	respondToPing = true
})

describe("AcpSessionClient", () => {
	describe("initialize", () => {
		it("connects to wss://.../session/{name}/connect with Bearer token", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "my-session",
				credentials: makeCredentials(),
				callbacks,
				cwd: "/repo",
				WebSocketImpl: MockWebSocket,
			})

			await initClient(client)

			expect(currentSocket().url).toBe("wss://worker.example.com/session/my-session/connect")
			expect(currentSocket().headers.Authorization).toBe("Bearer test-token-123")
			client.close()
		})

		it("sends initialize request with PROTOCOL_VERSION", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})

			const { socket } = await initClient(client)

			const sent = getSentMessages(socket)
			const initReq = sent.find((m) => m.method === "initialize")
			expect(initReq).toBeDefined()
			expect((initReq?.params as Record<string, unknown>)?.protocolVersion).toBe(1)

			client.close()
		})

		it("resumes an existing session via session/load when options.sessionId is set", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				cwd: "/repo",
				sessionId: "existing-acp-id",
				WebSocketImpl: MockWebSocket,
			})

			const { socket } = await initClientWithLoad(client)

			const sent = getSentMessages(socket)
			// session/new must NOT be sent — we attach to the existing session.
			expect(sent.some((m) => m.method === "session/new")).toBe(false)
			const loadReq = findRequest(sent, "session/load")
			expect(loadReq.params).toMatchObject({ sessionId: "existing-acp-id", cwd: "/repo", mcpServers: [] })
			// Opt-in flag lets the remote attach mid-turn (client takeover).
			expect((loadReq.params as { _meta?: unknown })._meta).toEqual({ "kimchi/reattachMidTurn": true })
			expect(client.sessionId).toBe("existing-acp-id")

			client.close()
		})

		it("captures the load replay in loadReplay (live updates excluded)", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				sessionId: "existing-acp-id",
				captureLoadReplay: true,
				WebSocketImpl: MockWebSocket,
			})

			const initPromise = client.initialize()
			await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
			const socket = currentSocket()
			openSocket(socket)
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "initialize")).toBe(true)
			})
			serverSendMessage(
				socket,
				rpcResponse(findRequest(getSentMessages(socket), "initialize").id, {
					protocolVersion: PROTOCOL_VERSION,
				}),
			)
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/load")).toBe(true)
			})
			const loadReq = findRequest(getSentMessages(socket), "session/load")

			// Historical updates streamed BEFORE the load response are the replay.
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "existing-acp-id",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "history" } },
				}),
			)
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "existing-acp-id",
					update: { sessionUpdate: "tool_call", toolCallId: "kt.bash.1", status: "completed", title: "run" },
				}),
			)
			serverSendMessage(socket, rpcResponse(loadReq.id, {}))

			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/set_config_option")).toBe(true)
			})
			const configReq = findRequest(getSentMessages(socket), "session/set_config_option")
			serverSendMessage(socket, rpcResponse(configReq.id, {}))

			await initPromise

			// A live update AFTER the load is not part of the captured replay.
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "existing-acp-id",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "live" } },
				}),
			)

			expect(client.loadReplay).toHaveLength(2)
			expect(client.loadReplay.map((n) => n.update.sessionUpdate)).toEqual(["agent_message_chunk", "tool_call"])
			client.close()
		})

		it("delivers foreign-id responses to onForeignResponse and consumes them", async () => {
			// After a mid-turn takeover, the ORIGINAL connection's prompt response
			// arrives with an id this connection never sent — the turn-end signal.
			// It must be delivered to the callback AND consumed (the SDK would
			// otherwise log "Got response to unknown request" for it).
			const onForeignResponse = vi.fn()
			const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				onForeignResponse,
				WebSocketImpl: MockWebSocket,
			})

			const { socket } = await initClient(client)

			// A response whose id matches no request sent on this connection.
			serverSendMessage(socket, rpcResponse(999, { stopReason: "end_turn" }))

			await vi.waitFor(() => expect(onForeignResponse).toHaveBeenCalledTimes(1))
			const frame = onForeignResponse.mock.calls[0]?.[0] as { id: number }
			expect(frame.id).toBe(999)
			// Known-id responses (the initialize/newSession handshake above)
			// never fired it — exactly one callback for the foreign frame.
			expect(onForeignResponse).toHaveBeenCalledTimes(1)
			// Consumed: the SDK never sees the foreign frame, so no error log.
			await new Promise((r) => setTimeout(r, 20))
			expect(errSpy).not.toHaveBeenCalled()
			errSpy.mockRestore()
			client.close()
		})

		it("suppresses replayed history during session/load, then dispatches live updates", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				sessionId: "existing-acp-id",
				WebSocketImpl: MockWebSocket,
			})

			const initPromise = client.initialize()
			await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
			const socket = currentSocket()
			openSocket(socket)
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "initialize")).toBe(true)
			})
			serverSendMessage(
				socket,
				rpcResponse(findRequest(getSentMessages(socket), "initialize").id, {
					protocolVersion: PROTOCOL_VERSION,
				}),
			)
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/load")).toBe(true)
			})
			const loadReq = findRequest(getSentMessages(socket), "session/load")

			// Replay: the server streams historical updates BEFORE responding to load.
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "existing-acp-id",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "duplicated history" } },
				}),
			)
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "existing-acp-id",
					update: { sessionUpdate: "tool_call", toolCallId: "tc-9", title: "old tool", status: "in_progress" },
				}),
			)
			serverSendMessage(socket, rpcResponse(loadReq.id, {}))

			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/set_config_option")).toBe(true)
			})
			serverSendMessage(socket, rpcResponse(findRequest(getSentMessages(socket), "session/set_config_option").id, {}))
			await initPromise

			// Replayed history must NOT reach user-facing callbacks — the local
			// transcript already received these events before the disconnect.
			expect(callbacks.onTextDelta).not.toHaveBeenCalled()
			expect(callbacks.onToolActivity).not.toHaveBeenCalled()

			// Replay capture is opt-in: without captureLoadReplay nothing is kept.
			expect(client.loadReplay).toHaveLength(0)

			// After the load resolves, fresh updates dispatch normally.
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "existing-acp-id",
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new text" } },
				}),
			)
			await vi.waitFor(() => expect(callbacks.onTextDelta).toHaveBeenCalled())

			client.close()
		})

		it("sends newSession with cwd and empty mcpServers", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				cwd: "/my/repo",
				WebSocketImpl: MockWebSocket,
			})

			const { socket } = await initClient(client)

			const sent = getSentMessages(socket)
			const newSessionReq = sent.find((m) => m.method === "session/new")
			expect(newSessionReq).toBeDefined()
			const params = newSessionReq?.params as Record<string, unknown>
			expect(params.cwd).toBe("/my/repo")
			expect(params.mcpServers).toEqual([])

			client.close()
		})

		it("stores the sessionId from newSession response", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})

			await initClient(client)
			expect(client.sessionId).toBe("session-abc")
			client.close()
		})

		it("defaults cwd to /home/sandbox when not specified", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})

			const { socket } = await initClient(client)

			const sent = getSentMessages(socket)
			const newSessionReq = sent.find((m) => m.method === "session/new")
			expect((newSessionReq?.params as Record<string, unknown>)?.cwd).toBe("/home/sandbox")

			client.close()
		})
	})

	describe("prompt", () => {
		it("sends session/prompt request with text content", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const promptPromise = client.prompt("Execute this plan")

			// Wait for the prompt request
			await vi.waitFor(() => {
				const sent = getSentMessages(socket)
				expect(sent.some((m) => m.method === "session/prompt")).toBe(true)
			})

			const sent = getSentMessages(socket)
			const promptReq = sent.find((m) => m.method === "session/prompt")
			const params = promptReq?.params as Record<string, unknown>
			expect(params.sessionId).toBe("session-abc")
			expect(params.prompt).toEqual([{ type: "text", text: "Execute this plan" }])

			// Respond with end_turn
			const promptId = promptReq?.id as string | number
			serverSendMessage(socket, rpcResponse(promptId, { stopReason: "end_turn" }))

			const result = await promptPromise
			expect(result.stopReason).toBe("end_turn")

			client.close()
		})

		it("does not time out a long-running prompt (no wall-clock cap)", async () => {
			vi.useFakeTimers()
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const promptPromise = client.prompt("long task")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			// Regression: prompt() previously rejected with RemoteConnectionError
			// after 10 minutes ("prompt timed out after 600000ms"), killing healthy
			// long-running remote turns. There is now no wall-clock cap — dead
			// connections are detected by the ping keepalive instead.
			vi.advanceTimersByTime(30 * 60_000)

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			const result = await promptPromise
			expect(result.stopReason).toBe("end_turn")

			client.close()
		})

		it("calls onTurnEnd with incremented turn count when prompt resolves", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			// First prompt
			const p1 = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const req1 = findRequest(getSentMessages(socket), "session/prompt")
			serverSendMessage(socket, rpcResponse(req1.id, { stopReason: "end_turn" }))
			await p1

			expect(callbacks.onTurnEnd).toHaveBeenCalledWith(1)

			// Second prompt
			const p2 = client.prompt("again")
			await vi.waitFor(() => {
				const sent = getSentMessages(socket)
				const prompts = sent.filter((m) => m.method === "session/prompt")
				expect(prompts.length).toBeGreaterThanOrEqual(2)
			})
			const req2 = findRequest(getSentMessages(socket), "session/prompt")
			serverSendMessage(socket, rpcResponse(req2.id, { stopReason: "end_turn" }))
			await p2

			expect(callbacks.onTurnEnd).toHaveBeenCalledWith(2)

			client.close()
		})

		it("resolves with usage when PromptResponse includes usage", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("do something")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})

			const req = findRequest(getSentMessages(socket), "session/prompt")
			serverSendMessage(
				socket,
				rpcResponse(req.id, {
					stopReason: "end_turn",
					usage: {
						inputTokens: 100,
						outputTokens: 200,
						cachedReadTokens: 50,
						cachedWriteTokens: 10,
						totalTokens: 360,
					},
				}),
			)
			const result = await p

			expect(result.usage).toEqual({
				input: 100,
				output: 200,
				cacheRead: 50,
				cacheWrite: 10,
			})
			expect(callbacks.onAssistantUsage).toHaveBeenCalledWith({
				input: 100,
				output: 200,
				cacheRead: 50,
				cacheWrite: 10,
			})

			client.close()
		})

		it("rejects a pending prompt when the transport stops answering pings", async () => {
			vi.useFakeTimers()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const promptPromise = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})

			// Half-open connection: WS stays open, messages stop flowing, pings go
			// unanswered. The keepalive (15s interval, 30s tolerance) must reject
			// the pending prompt instead of hanging forever.
			respondToPing = false
			vi.advanceTimersByTime(31_000)

			await expect(promptPromise).rejects.toThrow(RemoteConnectionError)
			await expect(promptPromise).rejects.toThrow("ping timeout")

			client.close()
		})

		it("throws if not initialized", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})

			await expect(client.prompt("hello")).rejects.toThrow(/not initialized/)
		})

		it("returns undefined usage when PromptResponse has no usage", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const req = findRequest(getSentMessages(socket), "session/prompt")
			serverSendMessage(socket, rpcResponse(req.id, { stopReason: "end_turn" }))
			const result = await p

			expect(result.usage).toBeUndefined()
			expect(callbacks.onAssistantUsage).not.toHaveBeenCalled()

			client.close()
		})
	})

	describe("cancel", () => {
		it("sends session/cancel notification", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			await client.cancel()

			const sent = getSentMessages(socket)
			const cancelMsg = sent.find((m) => m.method === "session/cancel")
			expect(cancelMsg).toBeDefined()
			expect((cancelMsg?.params as Record<string, unknown>)?.sessionId).toBe("session-abc")
			// Notifications have no id
			expect(cancelMsg?.id).toBeUndefined()

			client.close()
		})

		it("is a no-op before initialize", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})

			// Should not throw
			await client.cancel()
		})
	})

	describe("abort signal", () => {
		it("calls cancel() when the abort signal fires", async () => {
			const controller = new AbortController()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				signal: controller.signal,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			controller.abort()

			await vi.waitFor(() => {
				const sent = getSentMessages(socket)
				expect(sent.some((m) => m.method === "session/cancel")).toBe(true)
			})

			client.close()
		})

		it("calls cancel() immediately if signal is already aborted", async () => {
			const controller = new AbortController()
			controller.abort()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				signal: controller.signal,
				WebSocketImpl: MockWebSocket,
			})

			// initialize() should reject because the signal is already aborted —
			// _withAbortRejection rejects immediately when _aborted is true.
			// Call initialize() directly (not initClient) because initClient waits
			// for the socket to open before the rejection can surface, leaving an
			// unhandled rejection.
			const initPromise = client.initialize()
			// Allow the WebSocket to open so initialize() can proceed to the
			// _withAbortRejection check.
			await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
			openSocket(currentSocket())

			await expect(initPromise).rejects.toThrow("Aborted")

			client.close()
		})
	})

	describe("close", () => {
		it("closes the WebSocket", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})
			await initClient(client)

			client.close()

			expect(currentSocket().close).toHaveBeenCalled()
		})

		it("is safe to call multiple times", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})
			await initClient(client)

			client.close()
			client.close() // should not throw

			expect(currentSocket().close).toHaveBeenCalledTimes(1)
		})
	})

	describe("sessionUpdate dispatch", () => {
		it("dispatches agent_message_chunk to onTextDelta with delta and accumulated text", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			// Start a prompt so the client has a sessionId
			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			// Send two text chunks
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Hello " },
					},
				}),
			)
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "world!" },
					},
				}),
			)

			await vi.waitFor(() => {
				expect(callbacks.onTextDelta).toHaveBeenCalledTimes(2)
			})
			expect(callbacks.onTextDelta).toHaveBeenNthCalledWith(1, "Hello ", "Hello ")
			expect(callbacks.onTextDelta).toHaveBeenNthCalledWith(2, "world!", "Hello world!")

			// Complete the turn
			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("dispatches tool_call in_progress to onToolActivity start", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "Reading file.ts",
						status: "in_progress",
					},
				}),
			)

			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalledWith({
					toolName: "Reading file.ts",
					title: "Reading file.ts",
					toolCallId: "tc-1",
					status: "in_progress",
				})
			})

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("dispatches tool_call completed to onToolActivity end", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "Reading file.ts",
						status: "completed",
					},
				}),
			)

			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalledWith({
					toolName: "Reading file.ts",
					title: "Reading file.ts",
					toolCallId: "tc-1",
					status: "completed",
				})
			})

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("dispatches tool_call failed to onToolActivity end", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "Running tests",
						status: "failed",
					},
				}),
			)

			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalledWith({
					toolName: "Running tests",
					title: "Running tests",
					toolCallId: "tc-1",
					status: "failed",
				})
			})

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("dispatches tool_call_update status transition to in_progress as start", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						status: "in_progress",
					},
				}),
			)

			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalledWith({
					toolName: "tc-1",
					toolCallId: "tc-1",
					status: "in_progress",
					title: undefined,
				})
			})

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("dispatches tool_call_update status transition to completed as end", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						status: "completed",
						title: "Updated title",
					},
				}),
			)

			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalledWith({
					toolName: "Updated title",
					title: "Updated title",
					toolCallId: "tc-1",
					status: "completed",
				})
			})

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("resolves null-title tool_call_update from initial tool_call title", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			// Initial tool_call with a real title
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "pnpm run typecheck",
						status: "in_progress",
					},
				}),
			)
			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalledWith({
					toolName: "pnpm run typecheck",
					title: "pnpm run typecheck",
					toolCallId: "tc-1",
					status: "in_progress",
				})
			})

			// Update with null title — should resolve to the original
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						status: "completed",
					},
				}),
			)
			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalledWith({
					toolName: "pnpm run typecheck",
					title: "pnpm run typecheck",
					toolCallId: "tc-1",
					status: "completed",
				})
			})

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p

			client.close()
		})

		it("resolves title-less completed update from the LATEST update title, not the pending one", async () => {
			// Real wire sequence from the ACP server (src/modes/acp/server.ts):
			//   1. tool_call(pending, title from PARTIAL streaming args)
			//   2. tool_call_update(in_progress, title from full args)
			//   3. tool_call_update(completed, NO title)
			// The completed dispatch must carry the full (latest) title — the
			// stale pending title must not shadow it.
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "ec", // partial title from streaming args
						status: "pending",
					},
				}),
			)
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						title: "echo hello && cat file.ts", // full title
						status: "in_progress",
					},
				}),
			)
			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalledWith({
					toolName: "echo hello && cat file.ts",
					title: "echo hello && cat file.ts",
					toolCallId: "tc-1",
					status: "in_progress",
				})
			})

			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						status: "completed",
					},
				}),
			)
			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalledWith({
					toolName: "echo hello && cat file.ts",
					title: "echo hello && cat file.ts",
					toolCallId: "tc-1",
					status: "completed",
				})
			})

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("passes rawInput (tool args) through onToolActivity", async () => {
			// Real wire path: in_progress arrives as tool_call_update (after a
			// pending tool_call) — rawInput must flow through THAT case too.
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			// 1. pending announcement (args still streaming)
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "Run bash",
						status: "pending",
					},
				}),
			)
			// 2. execution starts — full args arrive on the UPDATE
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						title: "cd some dir && cat file.txt",
						status: "in_progress",
						rawInput: { command: "cd some dir && cat file.txt" },
					},
				}),
			)

			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalledWith({
					toolName: "cd some dir && cat file.txt",
					title: "cd some dir && cat file.txt",
					toolCallId: "tc-1",
					status: "in_progress",
					rawInput: { command: "cd some dir && cat file.txt" },
				})
			})

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("omits rawInput from the activity payload when the notification has none", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "Run bash",
						status: "in_progress",
					},
				}),
			)

			await vi.waitFor(() => {
				expect(callbacks.onToolActivity).toHaveBeenCalled()
			})
			const activity = (callbacks.onToolActivity as ReturnType<typeof vi.fn>).mock.calls[0][0]
			expect("rawInput" in activity).toBe(false)

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("ignores agent_thought_chunk, usage_update, plan, and other updates", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			// Send various ignored update types
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: "thinking..." },
					},
				}),
			)
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "usage_update",
						size: 128000,
						used: 5000,
					},
				}),
			)
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "plan",
						entries: [],
					},
				}),
			)

			// Yield so the async stream pipeline can process the notifications
			await new Promise((resolve) => setImmediate(resolve))

			// None of these should trigger any callback
			expect(callbacks.onTextDelta).not.toHaveBeenCalled()
			expect(callbacks.onToolActivity).not.toHaveBeenCalled()

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("does not dispatch callbacks when no callbacks are provided", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")

			// Should not throw
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "hi" },
					},
				}),
			)

			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})
	})

	describe("requestPermission (reject)", () => {
		it("rejects by cancelling when permission is requested", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})

			// Server sends a permission request (JSON-RPC request with id)
			const permReqId = "perm-1"
			serverSendMessage(socket, {
				jsonrpc: "2.0",
				id: permReqId,
				method: "session/request_permission",
				params: {
					sessionId: "session-abc",
					options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
					toolCall: { toolCallId: "tc-1", title: "Run bash" },
				},
			})

			// Wait for the client's response (sent back over the WebSocket)
			await vi.waitFor(() => {
				const sent = getSentMessages(socket)
				expect(sent.some((m) => m.id === permReqId && m.result)).toBe(true)
			})

			const sent = getSentMessages(socket)
			const permResp = sent.find((m) => m.id === permReqId)
			expect((permResp?.result as Record<string, unknown>)?.outcome).toEqual({
				outcome: "cancelled",
			})

			// Complete the prompt
			const promptReq = findRequest(getSentMessages(socket), "session/prompt")
			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})

		it("rejects with cancelled outcome when no options are provided", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})

			const permReqId = "perm-2"
			serverSendMessage(socket, {
				jsonrpc: "2.0",
				id: permReqId,
				method: "session/request_permission",
				params: {
					sessionId: "session-abc",
					options: [],
					toolCall: { toolCallId: "tc-1", title: "Run bash" },
				},
			})

			await vi.waitFor(() => {
				const sent = getSentMessages(socket)
				expect(sent.some((m) => m.id === permReqId && m.result)).toBe(true)
			})

			const sent = getSentMessages(socket)
			const permResp = sent.find((m) => m.id === permReqId)
			expect((permResp?.result as Record<string, unknown>)?.outcome).toEqual({
				outcome: "cancelled",
			})

			const promptReq = findRequest(getSentMessages(socket), "session/prompt")
			serverSendMessage(socket, rpcResponse(promptReq.id, { stopReason: "end_turn" }))
			await p
			client.close()
		})
	})

	describe("WebSocket ↔ stream bridge", () => {
		it("bridges incoming WebSocket messages to the ACP stream", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			// The fact that initialize() + newSession() succeeded means messages
			// flowed from WebSocket → ReadableStream → ndJsonStream → ClientSideConnection.
			// This is implicitly verified. Now verify outgoing direction:
			const sent = getSentMessages(socket)
			expect(sent.length).toBeGreaterThan(0)
			expect(sent.some((m) => m.jsonrpc === "2.0")).toBe(true)

			client.close()
		})

		it("handles binary WebSocket messages", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})

			// Override: simulate a binary message to verify it doesn't crash
			const initPromise = client.initialize()
			await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
			const socket = currentSocket()
			openSocket(socket)

			// Send a binary message — should be handled without crashing
			fireHandlers(socket, "message", Buffer.from(`${JSON.stringify(rpcResponse("nonexistent", {}))}\n`), true)

			// Still respond normally to initialize + newSession
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "initialize")).toBe(true)
			})
			const initReq = findRequest(getSentMessages(socket), "initialize")
			serverSendMessage(socket, rpcResponse(initReq.id, { protocolVersion: PROTOCOL_VERSION }))
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/new")).toBe(true)
			})
			const newSessionReq = findRequest(getSentMessages(socket), "session/new")
			serverSendMessage(socket, rpcResponse(newSessionReq.id, { sessionId: "session-abc" }))

			// Respond to session/set_config_option so initialize() can resolve
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/set_config_option")).toBe(true)
			})
			const configReq = findRequest(getSentMessages(socket), "session/set_config_option")
			serverSendMessage(socket, rpcResponse(configReq.id, {}))
			await initPromise

			client.close()
		})

		it("errors the stream when WebSocket errors", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})

			const initPromise = client.initialize()
			await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
			const socket = currentSocket()
			openSocket(socket)

			// Trigger an error — the initialize should reject
			fireHandlers(socket, "error", new Error("connection refused"))

			await expect(initPromise).rejects.toThrow("connection refused")

			client.close()
		})

		it("close() is safe after a failed initialize()", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})

			const initPromise = client.initialize()
			await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
			const socket = currentSocket()
			openSocket(socket)

			fireHandlers(socket, "error", new Error("connection refused"))

			await expect(initPromise).rejects.toThrow("connection refused")

			// Should not throw — _ws may be set, _connection/_sessionId are null
			client.close()
			client.close() // idempotent even after failed init

			expect(currentSocket().close).toHaveBeenCalledTimes(1)
		})
	})

	describe("URL construction", () => {
		it("URL-encodes the session name", async () => {
			const client = new AcpSessionClient({
				sessionName: "my session/with slashes",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})

			await initClient(client)

			expect(currentSocket().url).toBe("wss://worker.example.com/session/my%20session%2Fwith%20slashes/connect")
			client.close()
		})

		it("strips trailing slashes from wsUrl", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: {
					...makeCredentials(),
					wsUrl: "wss://worker.example.com/",
				},
				WebSocketImpl: MockWebSocket,
			})

			await initClient(client)

			expect(currentSocket().url).toBe("wss://worker.example.com/session/sess-1/connect")
			client.close()
		})
	})

	describe("multi-turn flow", () => {
		it("accumulates text per-turn (resets between prompts)", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			// Turn 1
			const p1 = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})
			const req1 = findRequest(getSentMessages(socket), "session/prompt")
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Turn 1 text" },
					},
				}),
			)
			serverSendMessage(socket, rpcResponse(req1.id, { stopReason: "end_turn" }))
			await p1

			expect(callbacks.onTextDelta).toHaveBeenLastCalledWith("Turn 1 text", "Turn 1 text")

			// Turn 2 — accumulated text should reset
			const p2 = client.prompt("again")
			await vi.waitFor(() => {
				const sent = getSentMessages(socket)
				const prompts = sent.filter((m) => m.method === "session/prompt")
				expect(prompts.length).toBeGreaterThanOrEqual(2)
			})
			const req2 = findRequest(getSentMessages(socket), "session/prompt")
			serverSendMessage(
				socket,
				rpcNotification("session/update", {
					sessionId: "session-abc",
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "Turn 2 text" },
					},
				}),
			)
			serverSendMessage(socket, rpcResponse(req2.id, { stopReason: "end_turn" }))
			await p2

			// The last onTextDelta should have only "Turn 2 text" as accumulated, not "Turn 1 textTurn 2 text"
			expect(callbacks.onTextDelta).toHaveBeenLastCalledWith("Turn 2 text", "Turn 2 text")

			client.close()
		})
	})

	describe("typed connectivity errors", () => {
		it("throws RemoteConnectionError when WS errors mid-initialize", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})

			const initPromise = client.initialize()
			await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
			const socket = currentSocket()
			openSocket(socket)

			fireHandlers(socket, "error", new Error("connection refused"))

			await expect(initPromise).rejects.toThrow("connection refused")
			// Verify it's specifically a RemoteConnectionError, not a generic Error
			try {
				await initPromise
			} catch (err) {
				expect(err).toBeInstanceOf(RemoteConnectionError)
			}

			client.close()
		})

		it("throws RemoteConnectionError when WS closes mid-prompt", async () => {
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const promptPromise = client.prompt("hello")

			// Wait for the prompt request to be sent
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})

			// Simulate WS close — the readable stream errors, the ACP connection's
			// pending prompt() promise should reject with RemoteConnectionError.
			socket.readyState = 3 // CLOSED
			fireHandlers(socket, "close")

			await expect(promptPromise).rejects.toThrow()
			try {
				await promptPromise
			} catch (err) {
				expect(err).toBeInstanceOf(RemoteConnectionError)
			}

			client.close()
		})

		it("does NOT throw RemoteConnectionError for ACP error stopReason", async () => {
			const { callbacks } = makeCallbacks()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				callbacks,
				WebSocketImpl: MockWebSocket,
			})
			const { socket } = await initClient(client)

			const p = client.prompt("hello")
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "session/prompt")).toBe(true)
			})

			// Respond with an error stopReason — this is a legitimate agent response,
			// not a transport error
			const req = findRequest(getSentMessages(socket), "session/prompt")
			serverSendMessage(socket, rpcResponse(req.id, { stopReason: "error" }))

			const result = await p
			expect(result.stopReason).toBe("error")
			// The prompt resolved normally — no RemoteConnectionError thrown

			client.close()
		})

		it("throws plain Error 'Aborted' (not RemoteConnectionError) on abort signal", async () => {
			const controller = new AbortController()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				signal: controller.signal,
				WebSocketImpl: MockWebSocket,
			})

			const initPromise = client.initialize()
			await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
			openSocket(currentSocket())

			controller.abort()

			await expect(initPromise).rejects.toThrow("Aborted")
			try {
				await initPromise
			} catch (err) {
				expect(err).not.toBeInstanceOf(RemoteConnectionError)
				expect(err).toBeInstanceOf(Error)
			}

			client.close()
		})

		it("throws RemoteConnectionError on timeout", async () => {
			vi.useFakeTimers()
			const client = new AcpSessionClient({
				sessionName: "sess-1",
				credentials: makeCredentials(),
				WebSocketImpl: MockWebSocket,
			})

			const initPromise = client.initialize()
			await vi.waitFor(() => expect(mockSockets).toHaveLength(1))
			const socket = currentSocket()
			openSocket(socket)

			// Wait for initialize request to be sent, then advance past the 30s timeout
			await vi.waitFor(() => {
				expect(getSentMessages(socket).some((m) => m.method === "initialize")).toBe(true)
			})

			vi.advanceTimersByTime(31_000)

			try {
				await initPromise
				expect.unreachable("initPromise should have rejected")
			} catch (err) {
				expect(err).toBeInstanceOf(RemoteConnectionError)
				expect(err instanceof Error && err.message).toContain("timed out")
			}

			client.close()
		})
	})
})

describe("extractFinalAssistantText", () => {
	const chunk = (text: string): SessionNotification =>
		({
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
		}) as unknown as SessionNotification
	const thought = (text: string): SessionNotification =>
		({
			update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } },
		}) as unknown as SessionNotification
	const toolCall = (): SessionNotification =>
		({
			update: { sessionUpdate: "tool_call", toolCallId: "kt.bash.1", status: "completed" },
		}) as unknown as SessionNotification
	const userChunk = (text: string): SessionNotification =>
		({
			update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
		}) as unknown as SessionNotification

	it("returns the text after the last tool call", () => {
		expect(extractFinalAssistantText([chunk("early text"), toolCall(), chunk("The "), chunk("answer")])).toBe(
			"The answer",
		)
	})

	it("resets on user messages", () => {
		expect(extractFinalAssistantText([chunk("stale"), userChunk("again"), chunk("fresh")])).toBe("fresh")
	})

	it("ignores interleaved thought chunks without ending the message", () => {
		expect(extractFinalAssistantText([toolCall(), chunk("a"), thought("hmm"), chunk("b")])).toBe("ab")
	})

	it("returns empty string when there is no assistant text", () => {
		expect(extractFinalAssistantText([userChunk("go"), toolCall()])).toBe("")
	})
})
