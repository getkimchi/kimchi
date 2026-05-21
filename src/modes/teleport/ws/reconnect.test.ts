import { beforeEach, describe, expect, it, vi } from "vitest"
import { ReconnectSupervisor } from "./reconnect.js"
import { WsCloseCode } from "./types.js"

let nextAuthResult: unknown = {
	connectToken: "tok",
	expiresAt: "2025-01-01T00:00:00Z",
	wsUrl: "wss://test.com/ws",
}
let nextAuthError: Error | undefined

vi.mock("../api/authenticate.js", async () => {
	const actual = await vi.importActual<typeof import("../api/authenticate.js")>("../api/authenticate.js")
	return {
		...actual,
		authenticateRemoteSession: vi.fn(async () => {
			if (nextAuthError) throw nextAuthError
			return nextAuthResult as { connectToken: string; expiresAt: string; wsUrl: string }
		}),
	}
})

const mockCreate = vi.fn()

vi.mock("./transport.js", () => ({
	WebSocketTransport: {
		create: (...args: unknown[]) => mockCreate(...args),
	},
}))

function makeMockTransport(closedPromise?: Promise<{ code: number; reason: string }>) {
	return {
		id: `mock-${Date.now()}`,
		readable: new ReadableStream({
			start(c) {
				c.close()
			},
		}),
		writable: new WritableStream(),
		close() {},
		closed: closedPromise ?? Promise.resolve({ code: 1000, reason: "" }),
		isConnected() {
			return true
		},
	}
}

describe("ReconnectSupervisor", () => {
	beforeEach(() => {
		nextAuthResult = {
			connectToken: "tok",
			expiresAt: "2025-01-01T00:00:00Z",
			wsUrl: "wss://test.com/ws",
		}
		nextAuthError = undefined
		mockCreate.mockReset()
		mockCreate.mockResolvedValue(makeMockTransport())
	})

	it("connects on start", async () => {
		const supervisor = new ReconnectSupervisor({
			sessionId: "s1",
			apiKey: "key",
			description: "test session",
		})

		const client = await supervisor.connect()
		expect(client).toBeDefined()
		expect(mockCreate).toHaveBeenCalledWith("wss://test.com/ws", { Authorization: "Bearer tok" })

		supervisor.dispose()
	})

	it("calls onFatal for fatal close codes", async () => {
		const onFatal = vi.fn()
		let closeResolve!: (value: { code: number; reason: string }) => void

		mockCreate.mockResolvedValueOnce(
			makeMockTransport(
				new Promise((resolve) => {
					closeResolve = resolve
				}),
			),
		)

		const supervisor = new ReconnectSupervisor({
			sessionId: "s1",
			apiKey: "key",
			description: "test session",
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
