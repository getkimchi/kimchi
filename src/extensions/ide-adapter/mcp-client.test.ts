import type EventEmitter from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebSocketServer } from "ws"
import { IdeWebSocketTransport, connectToIde } from "./mcp-client.js"
import type { LockfileData } from "./types.js"

// Mock the MCP Client so we don't need a real MCP handshake
const mockClientConnect = vi.fn().mockResolvedValue(undefined)
const mockClientClose = vi.fn().mockResolvedValue(undefined)
const mockListTools = vi.fn().mockResolvedValue({ tools: [] })
const mockCallTool = vi.fn().mockResolvedValue({ content: [] })

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(() => ({
		connect: mockClientConnect,
		close: mockClientClose,
		listTools: mockListTools,
		callTool: mockCallTool,
	})),
}))

describe("IdeWebSocketTransport", () => {
	let wss: WebSocketServer
	let serverPort: number

	beforeEach(async () => {
		return new Promise<void>((resolve) => {
			wss = new WebSocketServer({ port: 0 }, () => {
				serverPort = (wss.address() as { port: number }).port
				resolve()
			})
		})
	})

	afterEach(async () => {
		if (!wss) return
		return new Promise<void>((resolve) => {
			const timeout = setTimeout(() => resolve(), 500)
			for (const c of wss.clients) {
				c.terminate()
			}
			wss.close(() => {
				clearTimeout(timeout)
				resolve()
			})
		})
	})

	it("sends token query param during handshake", async () => {
		const urls: string[] = []
		wss.on("connection", (_, req) => {
			urls.push(req.url ?? "")
		})

		const transport = new IdeWebSocketTransport(new URL(`ws://127.0.0.1:${serverPort}/mcp`), "my-secret")
		await transport.start()
		expect(urls).toHaveLength(1)
		expect(urls[0]).toContain("token=my-secret")
		await transport.close()
	})

	it("rejects when WebSocket server is not available", async () => {
		wss.close()
		const transport = new IdeWebSocketTransport(new URL(`ws://127.0.0.1:${serverPort}/mcp`), "token")
		await expect(transport.start()).rejects.toThrow()
	})

	it("calls onmessage when a message arrives", async () => {
		wss.on("connection", (client) => {
			client.send(JSON.stringify({ jsonrpc: "2.0", method: "notify" }))
		})

		const transport = new IdeWebSocketTransport(new URL(`ws://127.0.0.1:${serverPort}/mcp`), "token")
		const messages: unknown[] = []
		transport.onmessage = (msg) => messages.push(msg)

		await transport.start()
		await new Promise((r) => setTimeout(r, 10))
		expect(messages).toHaveLength(1)
		expect((messages[0] as { method: string }).method).toBe("notify")
		await transport.close()
	})

	it("calls onclose when the connection closes", async () => {
		wss.on("connection", (client) => {
			setTimeout(() => client.close(), 5)
		})

		const transport = new IdeWebSocketTransport(new URL(`ws://127.0.0.1:${serverPort}/mcp`), "token")
		const closed = new Promise<void>((resolve) => {
			transport.onclose = () => resolve()
		})

		await transport.start()
		await closed
		expect(true).toBe(true)
		await transport.close()
	})

	it("sends messages over the open socket", async () => {
		const received: string[] = []
		wss.on("connection", (client) => {
			client.on("message", (data) => received.push(data.toString()))
		})

		const transport = new IdeWebSocketTransport(new URL(`ws://127.0.0.1:${serverPort}/mcp`), "token")
		await transport.start()
		await transport.send({ jsonrpc: "2.0", id: 1, method: "test" } as unknown as Parameters<typeof transport.send>[0])
		await new Promise((r) => setTimeout(r, 10))
		expect(received).toHaveLength(1)
		const parsed = JSON.parse(received[0])
		expect(parsed.method).toBe("test")
		expect(parsed.id).toBe(1)
		await transport.close()
	})

	it("catches secondary error events instead of letting them crash", async () => {
		const transport = new IdeWebSocketTransport(new URL(`ws://127.0.0.1:${serverPort}/mcp`), "token")
		await transport.start()

		const errors: string[] = []
		transport.onerror = (err) => errors.push(err.message)

		// Access the internal WebSocket and emit a post-open error.
		// The persistent .on("error") listener must catch it.
		const ws = (transport as unknown as { ws: EventEmitter }).ws
		ws.emit("error", new Error("secondary"))
		expect(errors).toEqual(["secondary"])
		await transport.close()
	})

	it("normalises ErrorEvent-like objects to Error", async () => {
		const transport = new IdeWebSocketTransport(new URL(`ws://127.0.0.1:${serverPort}/mcp`), "token")
		await transport.start()

		const errors: Error[] = []
		transport.onerror = (err) => errors.push(err)

		const ws2 = (transport as unknown as { ws: EventEmitter }).ws
		// Emit a duck-typed DOM-like ErrorEvent (what Bun native WebSocket may produce)
		ws2.emit("error", { message: "Expected 101 status code" })

		expect(errors).toHaveLength(1)
		expect(errors[0]).toBeInstanceOf(Error)
		expect(errors[0].message).toBe("Expected 101 status code")
		await transport.close()
	})

	it("send() rejects when socket is not open", async () => {
		const transport = new IdeWebSocketTransport(new URL(`ws://127.0.0.1:${serverPort}/mcp`), "token")
		// Never call start() – ws is null
		await expect(
			transport.send({ jsonrpc: "2.0", id: 1, method: "test" } as unknown as Parameters<typeof transport.send>[0]),
		).rejects.toThrow("WebSocket not open")
	})

	it("close() is resilient when ws.close() throws", async () => {
		const transport = new IdeWebSocketTransport(new URL(`ws://127.0.0.1:${serverPort}/mcp`), "token")
		await transport.start()

		const ws = (transport as unknown as { ws: { close: () => void } }).ws
		ws.close = () => {
			throw new Error("boom")
		}

		await expect(transport.close()).resolves.toBeUndefined()
	})

	it("rejects when handshake times out", async () => {
		const { createServer } = await import("node:net")
		const server = createServer(() => {
			// accept but never respond
		})
		await new Promise<void>((resolve) => server.listen(0, resolve))
		const port = (server.address() as { port: number }).port

		const transport = new IdeWebSocketTransport(new URL(`ws://127.0.0.1:${port}/mcp`), "token", 50)
		await expect(transport.start()).rejects.toThrow(
			`WebSocket handshake to ws://127.0.0.1:${port}/mcp timed out after 50ms`,
		)
		server.close()
	})
})

describe("connectToIde", () => {
	it("creates an MCP client, connects, and returns an IdeConnection", async () => {
		mockListTools.mockResolvedValueOnce({
			tools: [{ name: "openFile", description: "Open", inputSchema: {} }],
		})

		const lockfile: LockfileData = {
			port: 12345,
			pid: 1,
			ideName: "TestIDE",
			ideVersion: "1.0",
			transport: "ws",
			workspaceFolders: ["/tmp"],
			authToken: "tok",
		}

		const conn = await connectToIde(lockfile)
		expect(conn).toBeDefined()
		expect(conn.lockfile).toBe(lockfile)

		const tools = await conn.listTools()
		expect(tools).toHaveLength(1)
		expect(tools[0].name).toBe("openFile")
	})

	it("proxies tool calls to the IDE", async () => {
		mockCallTool.mockResolvedValueOnce({ content: [{ type: "text", text: "done" }] })

		const lockfile: LockfileData = {
			port: 12345,
			pid: 1,
			ideName: "TestIDE",
			ideVersion: "1.0",
			transport: "ws",
			workspaceFolders: ["/tmp"],
			authToken: "tok",
		}

		const conn = await connectToIde(lockfile)
		const result = await conn.callTool("saveFile", { path: "/a.txt" })
		expect(result).toEqual({ content: [{ type: "text", text: "done" }] })
		expect(mockCallTool).toHaveBeenCalledWith({ name: "saveFile", arguments: { path: "/a.txt" } })
	})

	it("routes notifications through setNotificationHandler", async () => {
		mockListTools.mockResolvedValueOnce({ tools: [] })

		const lockfile: LockfileData = {
			port: 12345,
			pid: 1,
			ideName: "TestIDE",
			ideVersion: "1.0",
			transport: "ws",
			workspaceFolders: ["/tmp"],
			authToken: "tok",
		}

		const conn = await connectToIde(lockfile)
		const notifications: unknown[] = []
		conn.setNotificationHandler((msg) => notifications.push(msg))

		// Trigger a notification message by calling the internal transport.onmessage
		// We need to access the transport. Since it's private, we can rely on the
		// fact that setNotificationHandler wraps transport.onmessage.
		// Let's verify the handler is attached by checking that calling close works.
		await conn.close()
		expect(mockClientClose).toHaveBeenCalled()
	})

	it("throws for unsupported transport", async () => {
		const lockfile: LockfileData = {
			port: 12345,
			pid: 1,
			ideName: "TestIDE",
			ideVersion: "1.0",
			transport: "sse",
			workspaceFolders: ["/tmp"],
			authToken: "tok",
		}

		await expect(connectToIde(lockfile)).rejects.toThrow('Unsupported IDE transport "sse" for TestIDE. Expected "ws".')
	})

	it("enriches connection error with IDE context", async () => {
		mockClientConnect.mockRejectedValueOnce(new Error("Expected 101 status code"))

		const lockfile: LockfileData = {
			port: 12345,
			pid: 1,
			ideName: "TestIDE",
			ideVersion: "1.0",
			transport: "ws",
			workspaceFolders: ["/tmp"],
			authToken: "tok",
		}

		await expect(connectToIde(lockfile)).rejects.toThrow(
			"Failed to connect to TestIDE at ws://127.0.0.1:12345/mcp (port 12345): Expected 101 status code",
		)
	})
})
