import { beforeEach, describe, expect, it, vi } from "vitest"
import { ReconnectSupervisor } from "./reconnect.js"
import { WsCloseCode } from "./types.js"

let nextAuthResult: unknown = {
	connectToken: "tok",
	expiresAt: "2025-01-01T00:00:00Z",
	wsUrl: "wss://test.com/ws",
}
let nextAuthError: Error | undefined

vi.mock("./auth.js", async () => {
	const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js")
	return {
		...actual,
		authenticateRemoteSession: vi.fn(async () => {
			if (nextAuthError) throw nextAuthError
			return nextAuthResult as { connectToken: string; expiresAt: string; wsUrl: string }
		}),
	}
})

vi.mock("./transport-ws.js", () => ({
	createWebSocketTransport: vi.fn().mockImplementation(async () => {
		return {
			readable: new ReadableStream({
				start(c) {
					c.close()
				},
			}),
			writable: new WritableStream(),
			close() {},
			closed: Promise.resolve({ code: 1000, reason: "" }),
		}
	}),
}))

describe("ReconnectSupervisor", () => {
	beforeEach(() => {
		nextAuthResult = {
			connectToken: "tok",
			expiresAt: "2025-01-01T00:00:00Z",
			wsUrl: "wss://test.com/ws",
		}
		nextAuthError = undefined
	})

	it("connects on start", async () => {
		const supervisor = new ReconnectSupervisor({
			sessionId: "s1",
			apiKey: "key",
		})

		const client = await supervisor.connect()
		expect(client).toBeDefined()

		supervisor.dispose()
	})

	it("calls onFatal for fatal close codes", async () => {
		const onFatal = vi.fn()
		let closeResolve!: (value: { code: number; reason: string }) => void

		const { createWebSocketTransport } = await import("./transport-ws.js")
		vi.mocked(createWebSocketTransport).mockResolvedValueOnce({
			readable: new ReadableStream({
				start(c) {
					c.close()
				},
			}),
			writable: new WritableStream(),
			close() {},
			closed: new Promise((resolve) => {
				closeResolve = resolve
			}),
		})

		const supervisor = new ReconnectSupervisor({
			sessionId: "s1",
			apiKey: "key",
		})
		supervisor.onFatal = onFatal

		await supervisor.connect()

		// Simulate fatal close
		closeResolve({ code: WsCloseCode.TakenOver, reason: "" })

		await new Promise((r) => setTimeout(r, 50))
		expect(onFatal).toHaveBeenCalled()

		supervisor.dispose()
	})
})
