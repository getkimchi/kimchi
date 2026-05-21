import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { type WebSocket, WebSocketServer } from "ws"
import { RemoteRpcClient } from "../ws/rpc-client.js"
import { WebSocketTransport } from "../ws/transport.js"
import { WsCloseCode } from "../ws/types.js"

describe("WebSocket integration", () => {
	it("connects, sends, receives response, and closes cleanly", async () => {
		const wss = new WebSocketServer({ port: 0 })
		const port = (wss.address() as AddressInfo).port
		const wsUrl = `ws://127.0.0.1:${port}`

		wss.on("connection", (ws: WebSocket) => {
			ws.on("message", (data: WebSocket.RawData) => {
				const line = String(data)
				const req = JSON.parse(line)
				ws.send(JSON.stringify({ type: "response", id: req.id, success: true, data: { pong: 1 } }))
			})
		})

		const transport = await WebSocketTransport.create(wsUrl, { Authorization: "Bearer token" })
		const client = new RemoteRpcClient(transport)

		const result = await client.send("ping", { hello: true })
		expect(result).toEqual({ pong: 1 })

		client.close(1000)
		await transport.closed

		wss.close()
	})

	it("server streaming events are received as AgentEvents", async () => {
		const wss = new WebSocketServer({ port: 0 })
		const port = (wss.address() as AddressInfo).port
		const wsUrl = `ws://127.0.0.1:${port}`

		wss.on("connection", (ws: WebSocket) => {
			ws.on("message", (data: WebSocket.RawData) => {
				const line = String(data)
				const req = JSON.parse(line)

				// stream turn_start event
				ws.send(JSON.stringify({ type: "turn_start" }))
				// stream agent_start event
				ws.send(JSON.stringify({ type: "agent_start" }))
				// send response
				ws.send(JSON.stringify({ type: "response", id: req.id, success: true, data: null }))
			})
		})

		const transport = await WebSocketTransport.create(wsUrl, { Authorization: "Bearer token" })
		const client = new RemoteRpcClient(transport)

		const events: string[] = []
		client.onEvent((e) => events.push(e.type))

		await client.send("prompt", { message: "hello" })

		await new Promise((r) => setTimeout(r, 50))
		expect(events).toContain("turn_start")
		expect(events).toContain("agent_start")

		client.close(1000)
		await transport.closed
		wss.close()
	})

	it("handles server-initiated close code 4003 (session finished)", async () => {
		const wss = new WebSocketServer({ port: 0 })
		const port = (wss.address() as AddressInfo).port
		const wsUrl = `ws://127.0.0.1:${port}`

		wss.on("connection", (ws: WebSocket) => {
			ws.on("message", (data: WebSocket.RawData) => {
				const line = String(data)
				const req = JSON.parse(line)
				ws.send(JSON.stringify({ type: "response", id: req.id, success: true, data: null }))
				// Server closes session after processing
				ws.close(WsCloseCode.SessionFinished, "done")
			})
		})

		const transport = await WebSocketTransport.create(wsUrl, { Authorization: "Bearer token" })
		const client = new RemoteRpcClient(transport)

		await client.send("abort", {})

		const closeInfo = await transport.closed
		expect(closeInfo.code).toBe(WsCloseCode.SessionFinished)
		expect(closeInfo.reason).toBe("done")

		wss.close()
	})
})
