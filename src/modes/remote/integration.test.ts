import { describe, expect, it, vi } from "vitest"
import { RemoteRpcClient } from "./rpc-client.js"
import type { Transport } from "./types.js"

function createFakeTransport() {
	const encoder = new TextEncoder()
	let readController: ReadableStreamDefaultController<Uint8Array>

	const readable = new ReadableStream<Uint8Array>({
		start(c) {
			readController = c
		},
	})

	const written: Uint8Array[] = []
	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			written.push(chunk)
		},
	})

	function injectLine(line: string) {
		readController.enqueue(encoder.encode(`${line}\n`))
	}

	function injectEvent(type: string, extra?: Record<string, unknown>) {
		injectLine(JSON.stringify({ type, ...extra }))
	}

	function injectResponse(id: string, success: boolean, data?: unknown, error?: string) {
		injectLine(JSON.stringify({ type: "response", id, success, data, error }))
	}

	const transport: Transport = {
		readable,
		writable,
		close() {
			readController.close()
		},
		closed: Promise.resolve({ code: 1000, reason: "" }),
	}

	return { transport, written, injectLine, injectEvent, injectResponse }
}

describe("Remote RPC integration", () => {
	it("full round trip: prompt + events + response", async () => {
		const { transport, written, injectEvent, injectResponse } = createFakeTransport()
		const client = new RemoteRpcClient(transport)

		// Start a prompt command
		const promptPromise = client.send("prompt", { message: "hello" })

		// Wait for the request to be written
		await new Promise((r) => setTimeout(r, 10))
		expect(written.length).toBeGreaterThan(0)

		const request = JSON.parse(new TextDecoder().decode(written[0]).trim())
		expect(request.type).toBe("prompt")
		expect(request.message).toBe("hello")

		// Server streams events back
		injectEvent("agent_start")
		injectEvent("message_start", {
			message: { role: "assistant", author: "gpt", parts: [{ content: "" }] },
		})
		injectEvent("message_update", {
			message: { role: "assistant", author: "gpt", parts: [{ content: "Hello" }] },
		})
		injectEvent("message_end", {
			message: { role: "assistant", author: "gpt", parts: [{ content: "Hello" }] },
		})
		injectEvent("agent_end", {
			messages: [
				{ role: "user", author: "user", parts: [{ content: "hello" }] },
				{ role: "assistant", author: "gpt", parts: [{ content: "Hello" }] },
			],
		})
		injectResponse(request.id, true)

		await promptPromise

		// Clean up
		client.close()
	})

	it("handles concurrent requests over the same transport", async () => {
		const { transport, written, injectResponse } = createFakeTransport()
		const client = new RemoteRpcClient(transport)

		const p1 = client.send("steer", { message: "A" })
		const p2 = client.send("follow_up", { message: "B" })

		await new Promise((r) => setTimeout(r, 10))

		const req1 = JSON.parse(new TextDecoder().decode(written[0]).trim())
		const req2 = JSON.parse(new TextDecoder().decode(written[1]).trim())
		injectResponse(req2.id, true, { result: "follow-up-ok" })
		injectResponse(req1.id, true, { result: "steer-ok" })

		const [r1, r2] = await Promise.all([p1, p2])
		expect(r1).toEqual({ result: "steer-ok" })
		expect(r2).toEqual({ result: "follow-up-ok" })

		client.close()
	})

	it("survives client close while requests are in flight", async () => {
		let readController: ReadableStreamDefaultController<Uint8Array>
		const transport: Transport = {
			readable: new ReadableStream({
				start(c) {
					readController = c
				},
			}),
			writable: new WritableStream(),
			close() {
				readController.close()
			},
			closed: Promise.resolve({ code: 1001, reason: "going away" }),
		}

		const client = new RemoteRpcClient(transport)

		const promptPromise = client.send("bash", { command: "ls" })

		await new Promise((r) => setTimeout(r, 10))

		// Simulate client close mid-flight
		client.close(1000)

		await expect(promptPromise).rejects.toThrow()
	})
})

describe("Event dispatching", () => {
	it("listeners fire for matching events", async () => {
		const { transport, injectEvent } = createFakeTransport()
		const client = new RemoteRpcClient(transport)

		const events: string[] = []
		client.onEvent((e) => events.push(e.type))

		injectEvent("turn_start")
		await new Promise((r) => setTimeout(r, 10))
		expect(events).toContain("turn_start")

		client.close()
	})

	it("removing listeners stops receiving events", async () => {
		const { transport, injectEvent } = createFakeTransport()
		const client = new RemoteRpcClient(transport)

		const events: string[] = []
		const unsub = client.onEvent((e) => events.push(e.type))

		injectEvent("turn_start")
		await new Promise((r) => setTimeout(r, 10))
		expect(events).toContain("turn_start")

		unsub()
		events.length = 0
		injectEvent("turn_end")
		await new Promise((r) => setTimeout(r, 10))
		expect(events).toHaveLength(0)

		client.close()
	})
})
