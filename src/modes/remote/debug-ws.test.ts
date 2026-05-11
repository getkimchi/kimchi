import { describe, expect, it } from "vitest"
import { WebSocketServer } from "ws"
import { createWebSocketTransport } from "./transport-ws.js"

describe("WebSocket availability debug", () => {
	it("prints ws constructor info", () => {
		console.log("WebSocket in globalThis:", "WebSocket" in globalThis)
		const globalWithWs = globalThis as typeof globalThis & {
			WebSocket?: typeof WebSocket
		}
		console.log("typeof WebSocket:", typeof globalWithWs.WebSocket)
		console.log("WebSocket == undefined:", globalWithWs.WebSocket === undefined)

		const ws = new WebSocketServer({ port: 0 })
		const port = (ws.address() as { port: number }).port
		console.log("Server port:", port)

		try {
			const wsCtor = globalWithWs.WebSocket
			if (!wsCtor) {
				console.log("WebSocket not available in globalThis")
				return
			}
			const nat = new wsCtor(`ws://127.0.0.1:${port}`)
			console.log("Created native ws, readyState:", nat.readyState)
			nat.addEventListener("open", () => console.log("native OPEN"))
			nat.addEventListener("error", () => console.log("native ERROR"))
		} catch (e) {
			console.log("Failed to create native ws:", (e as Error).message)
		}

		ws.close()
	})
})
