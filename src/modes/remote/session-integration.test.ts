import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import { ReconnectSupervisor } from "./reconnect.js"
import { RemoteAgentSession } from "./remote-agent-session.js"
import { RemoteRpcClient } from "./rpc-client.js"
import { createWebSocketTransport } from "./transport-ws.js"
import { WsCloseCode } from "./types.js"

describe("RemoteAgentSession WebSocket integration", () => {
	it("prompt round-trip with real WS server", async () => {
		let requestCount = 0

		// Create a mock WebSocket server that responds like a remote agent
		const wss = new WebSocketServer({ port: 0 })
		const port = (wss.address() as AddressInfo).port
		const wsUrl = `ws://localhost:${port}`

		wss.on("connection", (ws) => {
			ws.on("message", (raw) => {
				requestCount++
				const req = JSON.parse(String(raw))

				if (req.type === "prompt") {
					// Stream a full agent turn
					ws.send(JSON.stringify({ type: "agent_start" }))
					ws.send(
						JSON.stringify({
							type: "message_start",
							message: { role: "assistant", parts: [] },
						}),
					)
					ws.send(
						JSON.stringify({
							type: "message_end",
							message: {
								role: "assistant",
								parts: [{ content: "Hello!" }],
							},
						}),
					)
					ws.send(
						JSON.stringify({
							type: "agent_end",
							messages: [
								{
									role: "user",
									parts: [{ content: req.message }],
								},
								{
									role: "assistant",
									parts: [{ content: "Hello!" }],
								},
							],
						}),
					)
					ws.send(
						JSON.stringify({
							id: req.id,
							type: "response",
							command: req.type,
							success: true,
							data: null,
						}),
					)
				}
			})
		})

		// Connect transport directly to the mock server
		const transport = await createWebSocketTransport(wsUrl, "test-token")
		const client = new RemoteRpcClient(transport)

		// Build a supervisor that points nowhere — used for dispose() only here
		const supervisor = new ReconnectSupervisor({
			sessionId: "test-session",
			apiKey: "key",
		})

		const session = new RemoteAgentSession({
			rpcClient: client,
			supervisor,
		})

		// Listen to events
		const events: string[] = []
		session.subscribe((e: { type: string }) => events.push(e.type))

		// Send prompt
		await session.prompt("hi there", {})

		// Give a tick for asynchronous event delivery
		await new Promise((r) => setTimeout(r, 40))

		expect(requestCount).toBe(1)
		expect(events).toContain("agent_start")
		expect(events).toContain("agent_end")
		expect(events).toContain("message_end")
		expect(session.messages).toHaveLength(2)

		// Clean up
		session.dispose()
		wss.close()
	})

	it("reconnect supervisor swaps client on new connection", async () => {
		// First server
		const wss1 = new WebSocketServer({ port: 0 })
		const port1 = (wss1.address() as AddressInfo).port

		// Second server
		const wss2 = new WebSocketServer({ port: 0 })
		const port2 = (wss2.address() as AddressInfo).port

		wss1.on("connection", (ws) => {
			ws.on("message", (raw) => {
				const req = JSON.parse(String(raw))
				if (req.type === "prompt") {
					// Close abruptly to trigger reconnect
					setTimeout(() => ws.close(WsCloseCode.Normal), 10)
				}
			})
		})

		wss2.on("connection", (ws) => {
			ws.on("message", (raw) => {
				const req = JSON.parse(String(raw))
				if (req.type === "prompt") {
					ws.send(
						JSON.stringify({
							type: "agent_end",
							messages: [
								{
									role: "user",
									parts: [{ content: req.message }],
								},
							],
						}),
					)
					ws.send(
						JSON.stringify({
							id: req.id,
							type: "response",
							command: req.type,
							success: true,
							data: null,
						}),
					)
				}
			})
		})

		const transport1 = await createWebSocketTransport(`ws://localhost:${port1}`, "test-token")
		const client1 = new RemoteRpcClient(transport1)

		const supervisor = new ReconnectSupervisor({
			sessionId: "test-session",
			apiKey: "key",
		})

		const session = new RemoteAgentSession({
			rpcClient: client1,
			supervisor,
		})

		// Simulate a reconnect by swapping to client2
		const transport2 = await createWebSocketTransport(`ws://localhost:${port2}`, "test-token")
		const client2 = new RemoteRpcClient(transport2)

		session.swapRpcClient(client2)

		// Use client2 for prompt
		await session.prompt("reconnected", {})
		await new Promise((r) => setTimeout(r, 40))

		expect(session.messages).toHaveLength(1)

		// Clean up
		session.dispose()
		wss1.close()
		wss2.close()
	})
})
