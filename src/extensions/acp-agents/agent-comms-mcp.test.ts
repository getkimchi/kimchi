import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	LIST_AGENT_CONTACTS_TOOL_NAME,
	POST_AGENT_NOTE_TOOL_NAME,
	PostAgentNoteSchema,
	READ_AGENT_BOARD_TOOL_NAME,
	ReadAgentBoardSchema,
	SEND_AGENT_MESSAGE_TOOL_NAME,
} from "../agents/message-tool.js"
import { AgentMessageInputSchema } from "../agents/messages.js"
import { type AgentCommsMcpTool, agentCommsMcpTools, runAgentCommsMcp } from "./agent-comms-mcp.js"

const TEST_TOKEN = "test-token"

interface McpResponse {
	id: number
	result?: { tools?: AgentCommsMcpTool[]; content?: Array<{ type: string; text: string }> }
	error?: { code: number; message: string }
}

/** Serialize a TypeBox schema the same way the shim does (drops symbol
 *  modifiers, stamps the root object type when missing). */
function toJsonSchema(schema: object): Record<string, unknown> {
	const serialized = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
	if (serialized.type === undefined) serialized.type = "object"
	return serialized
}

describe("agentCommsMcpTools schema fidelity", () => {
	it("mirrors the live typebox schemas exactly, including camelCase agentId", () => {
		const tools = new Map(agentCommsMcpTools().map((t) => [t.name, t]))
		expect([...tools.keys()]).toEqual([
			LIST_AGENT_CONTACTS_TOOL_NAME,
			SEND_AGENT_MESSAGE_TOOL_NAME,
			POST_AGENT_NOTE_TOOL_NAME,
			READ_AGENT_BOARD_TOOL_NAME,
		])

		const send = tools.get(SEND_AGENT_MESSAGE_TOOL_NAME)
		// The union schema includes the camelCase peer recipient field.
		expect(JSON.stringify(send?.inputSchema)).toContain("agentId")
		expect(send?.inputSchema).toEqual(toJsonSchema(AgentMessageInputSchema))

		expect(tools.get(POST_AGENT_NOTE_TOOL_NAME)?.inputSchema).toEqual(toJsonSchema(PostAgentNoteSchema))
		expect(tools.get(READ_AGENT_BOARD_TOOL_NAME)?.inputSchema).toEqual(toJsonSchema(ReadAgentBoardSchema))

		const list = tools.get(LIST_AGENT_CONTACTS_TOOL_NAME)
		expect(list?.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false })
	})
})

describe("runAgentCommsMcp", () => {
	let dir: string
	let host: Server
	let hostSocketPath: string
	let input: PassThrough
	let output: PassThrough
	let outputLines: McpResponse[]
	/** Requests the fake host received. */
	let hostRequests: Array<{ id: string; token: string; method: string; params?: unknown }>
	let hostResponder:
		| ((req: { id: string; method: string }) => { result?: unknown; error?: string } | undefined)
		| undefined
	/** Live host-side connections, so tests can kill them (server.close only stops accepting). */
	let hostConnections: Socket[] = []
	let mcpId = 0

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "acp-mcp-shim-"))
		hostSocketPath = join(dir, "host.sock")
		hostRequests = []
		hostResponder = undefined
		hostConnections = []
		host = createServer((socket) => {
			socket.setEncoding("utf8")
			hostConnections.push(socket)
			let buffer = ""
			socket.on("data", (chunk) => {
				buffer += chunk
				const lines = buffer.split("\n")
				buffer = lines.pop() ?? ""
				for (const raw of lines) {
					const line = raw.trim()
					if (!line) continue
					const req = JSON.parse(line) as { id: string; token: string; method: string; params?: unknown }
					hostRequests.push(req)
					const response = hostResponder ? hostResponder(req) : { result: { ok: true, via: "host" } }
					if (response) socket.write(`${JSON.stringify({ id: req.id, ...response })}\n`)
				}
			})
		})
		host.listen(hostSocketPath)

		input = new PassThrough()
		output = new PassThrough()
		outputLines = []
		output.on("data", (chunk) => {
			for (const line of chunk.toString().split("\n")) {
				if (!line.trim()) continue
				outputLines.push(JSON.parse(line) as McpResponse)
			}
		})
		mcpId = 0
	})

	afterEach(() => {
		input.destroy()
		output.destroy()
		host.close()
		rmSync(dir, { recursive: true, force: true })
	})

	function sendMcp(method: string, params?: Record<string, unknown>): number {
		const id = ++mcpId
		input.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
		return id
	}

	async function awaitResponse(id: number): Promise<McpResponse> {
		const deadline = Date.now() + 3000
		while (Date.now() < deadline) {
			const found = outputLines.find((r) => r.id === id)
			if (found) return found
			await new Promise((r) => setTimeout(r, 20))
		}
		throw new Error(`no MCP response for id ${id}`)
	}

	it("handshakes, lists tools, and forwards tools/call to the host", async () => {
		const done = runAgentCommsMcp(hostSocketPath, TEST_TOKEN, { input, output })
		await new Promise((r) => setTimeout(r, 50))

		const initId = sendMcp("initialize", { protocolVersion: "2024-11-05" })
		const init = await awaitResponse(initId)
		expect(init.result).toMatchObject({
			protocolVersion: "2024-11-05",
			serverInfo: { name: "kimchi-agent-comms" },
			capabilities: { tools: {} },
		})

		// Notifications get no response.
		input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)

		const listId = sendMcp("tools/list")
		const list = await awaitResponse(listId)
		expect(list.result?.tools?.map((t) => t.name)).toContain(POST_AGENT_NOTE_TOOL_NAME)

		const callId = sendMcp("tools/call", {
			name: "post_agent_note",
			arguments: { kind: "note", title: "t", body: "b" },
		})
		const call = await awaitResponse(callId)
		expect(call.result?.content?.[0]).toEqual({ type: "text", text: JSON.stringify({ ok: true, via: "host" }) })

		// The host saw the request with the shim's token and the tool name.
		expect(hostRequests.at(-1)).toMatchObject({
			token: TEST_TOKEN,
			method: "post_agent_note",
			params: { kind: "note", title: "t", body: "b" },
		})

		input.end()
		await done
	})

	it("maps host errors to isError tool results", async () => {
		hostResponder = () => ({ error: "not authorized" })
		const done = runAgentCommsMcp(hostSocketPath, TEST_TOKEN, { input, output })
		await new Promise((r) => setTimeout(r, 50))

		const callId = sendMcp("tools/call", { name: "read_agent_board", arguments: {} })
		const call = await awaitResponse(callId)

		expect(call.result).toMatchObject({
			content: [{ type: "text", text: "not authorized" }],
			isError: true,
		})

		input.end()
		await done
	})

	it("answers ping and rejects unknown methods", async () => {
		const done = runAgentCommsMcp(hostSocketPath, TEST_TOKEN, { input, output })
		await new Promise((r) => setTimeout(r, 50))

		const pingId = sendMcp("ping")
		expect((await awaitResponse(pingId)).result).toEqual({})

		const badId = sendMcp("resources/list")
		const bad = await awaitResponse(badId)
		expect(bad.error?.code).toBe(-32601)

		input.end()
		await done
	})

	it("rejects when the host socket dies with pending requests", async () => {
		hostResponder = () => undefined
		const done = runAgentCommsMcp(hostSocketPath, TEST_TOKEN, { input, output })
		await new Promise((r) => setTimeout(r, 50))

		sendMcp("tools/call", { name: "list_agent_contacts", arguments: {} })
		await new Promise((r) => setTimeout(r, 50))
		// server.close() only stops accepting — destroy the live connection.
		for (const conn of hostConnections) conn.destroy()

		await expect(done).rejects.toThrow(/Host comms socket closed|ECONNRESET|socket/)
	}, 5000)
})
