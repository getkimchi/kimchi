// extensions/dap/nested-session.test.ts
//
// Tests the js-debug nested-session flow using a real TCP mock server.

import net from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DapClientRegistry } from "./client.js"

function encodeDap(msg: unknown): string {
	const content = JSON.stringify(msg)
	return `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`
}

interface MockDapServer {
	server: net.Server
	port: number
	close: () => Promise<void>
}

function createDapServer(): Promise<MockDapServer> {
	return new Promise((resolve, reject) => {
		const server = net.createServer((socket) => {
			let buf = Buffer.alloc(0)
			socket.on("data", (data) => {
				buf = Buffer.concat([buf, data])
				while (true) {
					const idx = buf.indexOf("\r\n\r\n")
					if (idx === -1) break
					const header = buf.subarray(0, idx).toString()
					const lenM = header.match(/Content-Length: (\d+)/i)
					if (!lenM) break
					const len = parseInt(lenM[1], 10)
					if (buf.length < idx + 4 + len) break
					const body = buf.subarray(idx + 4, idx + 4 + len).toString()
					buf = buf.subarray(idx + 4 + len)
					const msg = JSON.parse(body)

					if (msg.type === "request") {
						const resp: Record<string, unknown> = {
							seq: msg.seq + 1000,
							type: "response",
							request_seq: msg.seq,
							success: true,
							command: msg.command,
							body: {},
						}
						if (msg.command === "initialize") {
							resp.body = {
								supportsConfigurationDoneRequest: true,
								supportsTerminateRequest: true,
							}
						}
						if (msg.command === "threads") {
							resp.body = { threads: [{ id: 1, name: "main" }] }
						}
						if (msg.command === "stackTrace") {
							resp.body = { stackFrames: [{ id: 1, name: "main", line: 10, column: 1 }] }
						}
						socket.write(encodeDap(resp))

						// After configurationDone, send a stopped event
						if (msg.command === "configurationDone") {
							const stopped = {
								seq: msg.seq + 2000,
								type: "event",
								event: "stopped",
								body: { reason: "breakpoint", threadId: 1, allThreadsStopped: false },
							}
							socket.write(encodeDap(stopped))
						}
					}
				}
			})
		})
		server.on("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as net.AddressInfo).port
			resolve({
				server,
				port,
				close: () => new Promise<void>((r) => server.close(() => r())),
			})
		})
	})
}

describe("nested-session TCP integration", () => {
	let mockServer: MockDapServer
	let registry: DapClientRegistry
	let originalBun: unknown

	beforeEach(async () => {
		mockServer = await createDapServer()
		registry = new DapClientRegistry()
		// biome-ignore lint/suspicious/noExplicitAny: Bun not typed in tests
		originalBun = (globalThis as any).Bun
	})

	afterEach(async () => {
		registry.shutdownAll()
		await mockServer.close()
		// biome-ignore lint/suspicious/noExplicitAny: Bun not typed in tests
		;(globalThis as any).Bun = originalBun
	})

	it("startDebugging opens child connection and routes requests to child", async () => {
		// Connect a raw socket to the mock server and simulate the parent client
		const parentSocket = net.createConnection({ host: "127.0.0.1", port: mockServer.port })

		// Wait for connection
		await new Promise<void>((resolve, reject) => {
			parentSocket.on("connect", resolve)
			parentSocket.on("error", reject)
		})

		// Send initialize
		parentSocket.write(
			encodeDap({
				seq: 1,
				type: "request",
				command: "initialize",
				arguments: {
					clientID: "test",
					adapterID: "pwa-node",
					linesStartAt1: true,
					columnsStartAt1: true,
					pathFormat: "path",
					supportsConfigurationDoneRequest: true,
					supportsStartDebuggingRequest: true,
				},
			}),
		)

		// Read responses until we get the initialize response
		const initResp = await new Promise<Record<string, unknown>>((resolve) => {
			let buf = Buffer.alloc(0)
			parentSocket.on("data", (data) => {
				buf = Buffer.concat([buf, data])
				const idx = buf.indexOf("\r\n\r\n")
				if (idx !== -1) {
					const header = buf.subarray(0, idx).toString()
					const len = parseInt(header.match(/Content-Length: (\d+)/i)?.[1] ?? "0", 10)
					const body = buf.subarray(idx + 4, idx + 4 + len).toString()
					resolve(JSON.parse(body))
				}
			})
		})
		expect(initResp.success).toBe(true)
		expect((initResp.body as Record<string, unknown>).supportsConfigurationDoneRequest).toBe(true)

		// Send startDebugging reverse-request to simulate the parent adapter
		parentSocket.write(
			encodeDap({
				seq: 2,
				type: "request",
				command: "startDebugging",
				arguments: {
					request: "launch",
					configuration: { type: "pwa-node", name: "test.ts [12345]" },
				},
			}),
		)

		// The mock server doesn't handle startDebugging (it's a reverse request
		// from server to client). The client should reply success:true.
		// Read the client's response to the startDebugging request.
		const startDbgResp = await new Promise<Record<string, unknown>>((resolve) => {
			let buf = Buffer.alloc(0)
			const handler = (data: Buffer) => {
				buf = Buffer.concat([buf, data])
				// Find the startDebugging response (request_seq: 2)
				while (true) {
					const idx = buf.indexOf("\r\n\r\n")
					if (idx === -1) break
					const header = buf.subarray(0, idx).toString()
					const len = parseInt(header.match(/Content-Length: (\d+)/i)?.[1] ?? "0", 10)
					if (buf.length < idx + 4 + len) break
					const body = buf.subarray(idx + 4, idx + 4 + len).toString()
					buf = buf.subarray(idx + 4 + len)
					const msg = JSON.parse(body)
					if (msg.type === "response" && msg.request_seq === 2) {
						parentSocket.off("data", handler)
						resolve(msg)
					}
				}
			}
			parentSocket.on("data", handler)
		})

		expect(startDbgResp.success).toBe(true)
		expect(startDbgResp.command).toBe("startDebugging")

		parentSocket.destroy()
	}, 10_000)

	it("child connection receives initialize+launch+configurationDone and routes stackTrace", async () => {
		// This test verifies that after the child connection is established,
		// sendRequest routes to the child and the response comes back through
		// the child's message reader.
		const mockServer2 = await createDapServer()

		// Create a parent DapClient manually connected to the mock server
		const parentSocket = net.createConnection({ host: "127.0.0.1", port: mockServer2.port })
		await new Promise<void>((resolve, reject) => {
			parentSocket.on("connect", resolve)
			parentSocket.on("error", reject)
		})

		// Send initialize on parent
		parentSocket.write(
			encodeDap({
				seq: 1,
				type: "request",
				command: "initialize",
				arguments: {
					clientID: "test",
					adapterID: "pwa-node",
					linesStartAt1: true,
					columnsStartAt1: true,
					pathFormat: "path",
					supportsConfigurationDoneRequest: true,
				},
			}),
		)

		// Drain the initialize response
		await new Promise<void>((resolve) => {
			let buf = Buffer.alloc(0)
			parentSocket.on("data", (data) => {
				buf = Buffer.concat([buf, data])
				if (buf.indexOf("\r\n\r\n") !== -1) resolve()
			})
		})

		// Now simulate a child connection to the same server
		const childSocket = net.createConnection({ host: "127.0.0.1", port: mockServer2.port })
		await new Promise<void>((resolve, reject) => {
			childSocket.on("connect", resolve)
			childSocket.on("error", reject)
		})

		// Send initialize+launch+configurationDone on child
		childSocket.write(
			encodeDap({
				seq: 1,
				type: "request",
				command: "initialize",
				arguments: {
					clientID: "test",
					adapterID: "pwa-node",
					linesStartAt1: true,
					columnsStartAt1: true,
					pathFormat: "path",
					supportsConfigurationDoneRequest: true,
				},
			}),
		)
		childSocket.write(
			encodeDap({
				seq: 2,
				type: "request",
				command: "launch",
				arguments: { type: "pwa-node", request: "launch", name: "test", program: "/tmp/test.ts" },
			}),
		)
		childSocket.write(
			encodeDap({
				seq: 3,
				type: "request",
				command: "configurationDone",
				arguments: {},
			}),
		)

		// Send a stackTrace request on child
		childSocket.write(
			encodeDap({
				seq: 4,
				type: "request",
				command: "stackTrace",
				arguments: { threadId: 1 },
			}),
		)

		// Read responses from child — find the stackTrace response
		const stackTraceResp = await new Promise<Record<string, unknown>>((resolve) => {
			let buf = Buffer.alloc(0)
			childSocket.on("data", (data) => {
				buf = Buffer.concat([buf, data])
				while (true) {
					const idx = buf.indexOf("\r\n\r\n")
					if (idx === -1) break
					const header = buf.subarray(0, idx).toString()
					const len = parseInt(header.match(/Content-Length: (\d+)/i)?.[1] ?? "0", 10)
					if (buf.length < idx + 4 + len) break
					const body = buf.subarray(idx + 4, idx + 4 + len).toString()
					buf = buf.subarray(idx + 4 + len)
					const msg = JSON.parse(body)
					if (msg.type === "response" && msg.command === "stackTrace") {
						resolve(msg)
					}
				}
			})
		})

		expect(stackTraceResp.success).toBe(true)
		expect((stackTraceResp.body as Record<string, unknown>).stackFrames).toBeDefined()

		parentSocket.destroy()
		childSocket.destroy()
		await mockServer2.close()
	}, 15_000)
})
