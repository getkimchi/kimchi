import { describe, expect, it, vi } from "vitest"
import { RemoteRpcClient } from "./rpc-client.js"

function makeMockTransport() {
	const encoder = new TextEncoder()
	let readableController!: ReadableStreamDefaultController<Uint8Array>

	const readable = new ReadableStream<Uint8Array>({
		start(controller) {
			readableController = controller
		},
	})

	const written: Uint8Array[] = []
	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			written.push(chunk)
		},
	})

	function injectLine(line: string) {
		readableController.enqueue(encoder.encode(`${line}\n`))
	}

	function injectResponse(id: string, success: boolean, data?: unknown, error?: string) {
		const payload: Record<string, unknown> = { id, type: "response", success }
		if (data !== undefined) payload.data = data
		if (error !== undefined) payload.error = error
		injectLine(JSON.stringify(payload))
	}

	function injectEvent(type: string, extra: Record<string, unknown> = {}) {
		injectLine(JSON.stringify({ type, ...extra }))
	}

	function closeTransport() {
		readableController.close()
	}

	return {
		transport: {
			id: `mock-${Date.now()}`,
			readable,
			writable,
			close() {
				closeTransport()
			},
			closed: Promise.resolve({ code: 1000, reason: "" }),
			isConnected() {
				return true
			},
		},
		written,
		injectResponse,
		injectEvent,
		injectLine,
		closeTransport,
	}
}

describe("RemoteRpcClient", () => {
	it("correlates responses to pending requests using id", async () => {
		const { transport, written, injectResponse } = makeMockTransport()
		const client = new RemoteRpcClient(transport)

		const promise = client.send("get_state")

		await new Promise((r) => setTimeout(r, 10))

		const req = JSON.parse(new TextDecoder().decode(written[0]).trim())
		expect(req.type).toBe("get_state")
		expect(req.id).toMatch(/^req_\d+$/)
		const reqId = req.id as string

		injectResponse(reqId, true, { sessionId: "abc" })

		const result = await promise
		expect(result).toEqual({ sessionId: "abc" })

		client.close()
	})

	it("rejects on error response", async () => {
		const { transport, written, injectResponse } = makeMockTransport()
		const client = new RemoteRpcClient(transport)

		const promise = client.send("bash", { command: "ls" })

		await new Promise((r) => setTimeout(r, 10))
		const req = JSON.parse(new TextDecoder().decode(written[0]).trim())
		injectResponse(req.id as string, false, undefined, "bash not allowed")

		await expect(promise).rejects.toThrow("bash not allowed")

		client.close()
	})

	it("dispatches events (no matching id) to listeners", async () => {
		const { transport, injectEvent } = makeMockTransport()
		const client = new RemoteRpcClient(transport)

		const events: unknown[] = []
		client.onEvent((e) => events.push(e))

		injectEvent("agent_start")

		await new Promise((r) => setTimeout(r, 10))

		expect(events).toHaveLength(1)
		expect((events[0] as { type: string }).type).toBe("agent_start")

		client.close()
	})

	it("treats lines lacking type:'response' as events even if they carry an id", async () => {
		// Some servers tag streaming events with their causal request id; those
		// must NOT short-circuit a pending request — only payloads with
		// type:"response" resolve.
		const { transport, written, injectLine } = makeMockTransport()
		const client = new RemoteRpcClient(transport)

		const events: { type: string }[] = []
		client.onEvent((e) => events.push(e as { type: string }))

		const promise = client.send("prompt", { message: "hi" })
		await new Promise((r) => setTimeout(r, 10))
		const req = JSON.parse(new TextDecoder().decode(written[0]).trim())

		// Streaming event tagged with the request id but type != "response"
		injectLine(JSON.stringify({ id: req.id, type: "message_start", message: {} }))
		await new Promise((r) => setTimeout(r, 10))

		// Pending request should not have resolved yet
		let settled = false
		promise.then(() => {
			settled = true
		})
		await new Promise((r) => setTimeout(r, 10))
		expect(settled).toBe(false)
		expect(events).toHaveLength(1)
		expect(events[0].type).toBe("message_start")

		// Now send a proper response
		injectLine(JSON.stringify({ id: req.id, type: "response", success: true, data: null }))
		await expect(promise).resolves.toBeNull()

		client.close()
	})

	it("rejects pending requests on close", async () => {
		const { transport } = makeMockTransport()
		const client = new RemoteRpcClient(transport)

		const promise = client.send("prompt", { message: "hi" })

		await new Promise((r) => setTimeout(r, 10))

		client.close()

		await expect(promise).rejects.toThrow("Connection closed")
	})

	it("times out after the configured request timeout", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		const { transport } = makeMockTransport()
		const client = new RemoteRpcClient(transport)

		const promise = client.send("compact")

		vi.advanceTimersByTime(60_001)

		await expect(promise).rejects.toThrow(/timed out/)

		client.close()
		vi.useRealTimers()
	})

	it("queues multiple writes without dropping any", async () => {
		const { transport, written } = makeMockTransport()
		const client = new RemoteRpcClient(transport)

		client.send("prompt", { message: "a" }).catch(() => {})
		client.send("prompt", { message: "b" }).catch(() => {})
		client.send("prompt", { message: "c" }).catch(() => {})

		await new Promise((r) => setTimeout(r, 10))

		expect(written).toHaveLength(3)
		const ids = written.map((w) => JSON.parse(new TextDecoder().decode(w).trim()).id as string)
		expect(new Set(ids).size).toBe(3) // all distinct
		for (const w of written) {
			const parsed = JSON.parse(new TextDecoder().decode(w).trim())
			expect(parsed.type).toBe("prompt")
		}

		client.close()
	})
})
