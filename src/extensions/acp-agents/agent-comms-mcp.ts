/**
 * agent-comms-mcp.ts — MCP stdio shim for ACP agent communication tools.
 *
 * Runs inside the kimchi process via the hidden `--agent-comms-mcp <socket>
 * <token>` CLI mode (see `parseAgentCommsMcpArgs` in cli-args.ts and the
 * early-exit wiring in cli.ts). The external ACP agent spawns this process
 * from the `mcpServers` entry we pass in newSession, and gets the same four
 * communication tools in-process agents have: list_agent_contacts,
 * send_agent_message, post_agent_note, read_agent_board.
 *
 * Tool schemas are derived from the LIVE typebox schemas (messages.ts /
 * message-tool.ts) via a JSON round-trip that strips TypeBox symbol
 * modifiers — so the shim can never drift from the in-process tools,
 * including the camelCase `agentId` recipient field.
 *
 * The shim is a dumb proxy: it speaks MCP on stdio and forwards tools/call
 * to the host IPC socket; the host re-validates token → live record and
 * stamps author identity. It exits when stdin closes (resolve) or the
 * socket dies (reject).
 */

import { connect, type Socket } from "node:net"
import { createInterface } from "node:readline"
import {
	LIST_AGENT_CONTACTS_TOOL_NAME,
	POST_AGENT_NOTE_TOOL_NAME,
	PostAgentNoteSchema,
	READ_AGENT_BOARD_TOOL_NAME,
	ReadAgentBoardSchema,
	SEND_AGENT_MESSAGE_TOOL_NAME,
} from "../agents/message-tool.js"
import { AgentMessageInputSchema } from "../agents/messages.js"
import { createJsonLineReader, type IpcResponse } from "./comms-ipc.js"

/** Serialize a TypeBox schema to plain JSON Schema (drops symbol modifiers).
 *  MCP requires inputSchema.type === "object" at the root — TypeBox unions
 *  (anyOf) serialize without a root type, and real MCP clients reject the
 *  whole tools/list response over it, so stamp the object type when missing. */
function toJsonSchema(schema: object): Record<string, unknown> {
	const serialized = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>
	if (serialized.type === undefined) serialized.type = "object"
	return serialized
}

export interface AgentCommsMcpTool {
	name: string
	description: string
	inputSchema: Record<string, unknown>
}

/** The four communication tools this shim exposes, mirroring the in-process tools. */
export function agentCommsMcpTools(): AgentCommsMcpTool[] {
	return [
		{
			name: LIST_AGENT_CONTACTS_TOOL_NAME,
			description:
				"List recipients the host currently authorizes for this agent. Call again if peer state may have changed.",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			name: SEND_AGENT_MESSAGE_TOOL_NAME,
			description:
				"Send one focused message to an authorized contact. A receipt proves only host queue acceptance or a completed bounded resume attempt; it does not prove delivery or recipient action.",
			inputSchema: toJsonSchema(AgentMessageInputSchema),
		},
		{
			name: POST_AGENT_NOTE_TOOL_NAME,
			description:
				"Post a note/work/finding/warning to the shared coordination board for the agent group. The board is shared append-only group space; use send_agent_message for directed 1:1 communication.",
			inputSchema: toJsonSchema(PostAgentNoteSchema),
		},
		{
			name: READ_AGENT_BOARD_TOOL_NAME,
			description:
				"Read new board entries since an id, filtered by kind, up to a limit. Returns only authorized entries for the caller's group. Pass since_id on re-reads to get only new entries.",
			inputSchema: toJsonSchema(ReadAgentBoardSchema),
		},
	]
}

/**
 * Run the MCP shim until stdin closes or the host socket dies.
 * Resolves on stdin end; rejects when the host socket errors or closes early.
 */
export function runAgentCommsMcp(
	socketPath: string,
	token: string,
	io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const sock: Socket = connect(socketPath)

		let nextIpcId = 1
		const pendingIpc = new Map<string, (outcome: { result?: unknown; error?: string }) => void>()

		sock.setEncoding("utf8")
		sock.on(
			"data",
			createJsonLineReader((message) => {
				const res = message as IpcResponse
				pendingIpc.get(res.id)?.({ result: res.result, error: res.error })
				pendingIpc.delete(res.id)
			}),
		)
		sock.on("error", (err) => {
			for (const settle of pendingIpc.values()) settle({ error: err.message })
			pendingIpc.clear()
			reject(err)
		})
		sock.on("close", () => {
			// A clean shutdown resolves via stdin end first; reaching close with
			// pending work means the host died under us.
			if (pendingIpc.size > 0) reject(new Error("Host comms socket closed with pending requests"))
			else resolve()
		})

		const output = io.output ?? process.stdout
		const sendMcp = (msg: unknown): void => {
			output.write(`${JSON.stringify(msg)}\n`)
		}

		const respondMcp = (id: number | string, result: unknown): void => {
			sendMcp({ jsonrpc: "2.0", id, result })
		}

		const respondMcpError = (id: number | string, code: number, message: string): void => {
			sendMcp({ jsonrpc: "2.0", id, error: { code, message } })
		}

		const forwardToHost = (method: string, params: unknown): Promise<{ result?: unknown; error?: string }> => {
			return new Promise((settle) => {
				const ipcId = `shim-${nextIpcId++}`
				pendingIpc.set(ipcId, settle)
				sock.write(`${JSON.stringify({ id: ipcId, token, method, params })}\n`)
			})
		}

		const handleMcpRequest = async (msg: {
			id?: number | string
			method?: string
			params?: { name?: string; arguments?: unknown; protocolVersion?: string }
		}): Promise<void> => {
			const id = msg.id
			switch (msg.method) {
				case "initialize": {
					respondMcp(id as number | string, {
						protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "kimchi-agent-comms", version: "1.0.0" },
					})
					break
				}
				case "ping": {
					respondMcp(id as number | string, {})
					break
				}
				case "tools/list": {
					respondMcp(id as number | string, { tools: agentCommsMcpTools() })
					break
				}
				case "tools/call": {
					const toolName = msg.params?.name
					if (typeof toolName !== "string") {
						respondMcpError(id as number | string, -32602, "tools/call requires a tool name")
						break
					}
					const outcome = await forwardToHost(toolName, msg.params?.arguments)
					if (outcome.error !== undefined) {
						respondMcp(id as number | string, {
							content: [{ type: "text", text: outcome.error }],
							isError: true,
						})
					} else {
						respondMcp(id as number | string, {
							content: [{ type: "text", text: JSON.stringify(outcome.result) }],
						})
					}
					break
				}
				default: {
					respondMcpError(id as number | string, -32601, `Unknown method: ${String(msg.method)}`)
				}
			}
		}

		const readline = createInterface({ input: io.input ?? process.stdin })
		readline.on("line", (line) => {
			const trimmed = line.trim()
			if (!trimmed) return
			let msg: { id?: number | string; method?: string; params?: Record<string, unknown> }
			try {
				msg = JSON.parse(trimmed)
			} catch {
				return
			}
			// Notifications (no id) get no response per JSON-RPC.
			if (msg.id === undefined) return
			void handleMcpRequest(msg as Parameters<typeof handleMcpRequest>[0]).catch((err: unknown) => {
				respondMcpError(msg.id as number | string, -32603, err instanceof Error ? err.message : String(err))
			})
		})
		readline.on("close", () => {
			sock.end()
			resolve()
		})
	})
}
