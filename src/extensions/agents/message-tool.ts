import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { markHarnessSteer } from "../steer-marker.js"
import { isTodoWriteToolName, isWriteTodosDetails } from "../todos/session.js"
import {
	BOARD_ENTRY_BODY_MAX,
	BOARD_ENTRY_TITLE_MAX,
	type BoardEntryKind,
	type BoardPostReceipt,
	type BoardReadReceipt,
} from "./manager/board.js"
import {
	type AgentMessageInput,
	type AgentMessageReceipt,
	AgentMessageToolSchema,
	validateAgentMessageInput,
} from "./messages.js"
import { agentBoardResult, agentMessageResult, textResult } from "./tool-result.js"

export const LIST_AGENT_CONTACTS_TOOL_NAME = "list_agent_contacts"
export const SEND_AGENT_MESSAGE_TOOL_NAME = "send_agent_message"
export const POST_AGENT_NOTE_TOOL_NAME = "post_agent_note"
export const READ_AGENT_BOARD_TOOL_NAME = "read_agent_board"

export interface AgentContact {
	agent_id?: string
	persona?: string
	description?: string
	status?: string
	reachable: boolean
	route?: "parent" | "peer" | "questionnaire" | "ferment_judge" | "unavailable"
	ferment_id?: string
	reason?: string
}

export interface AgentContactList {
	parent: AgentContact
	user_via_parent: AgentContact
	peers: AgentContact[]
	/** Board hint for deliberate peer posts, excluding automatic TODO progress. */
	board?: { total: number; latestId?: string }
}

export interface AgentMessageCapability {
	listContacts(): AgentContactList
	sendMessage(toolCallId: string, input: AgentMessageInput): Promise<AgentMessageReceipt>
	/** Post a note/work/finding/warning to the shared coordination board. */
	postBoardEntry(input: { kind: BoardEntryKind; title: string; body: string; snapshotKey?: string }): BoardPostReceipt
	/** Read board entries for the caller's group. */
	readBoardEntries(opts?: { sinceId?: string; kind?: BoardEntryKind; limit?: number }): BoardReadReceipt
}

export const PostAgentNoteSchema = Type.Object(
	{
		kind: Type.Enum({
			note: "note" as const,
			work: "work" as const,
			finding: "finding" as const,
			warning: "warning" as const,
		}),
		title: Type.String({ maxLength: BOARD_ENTRY_TITLE_MAX }),
		body: Type.String({ maxLength: BOARD_ENTRY_BODY_MAX }),
	},
	{ additionalProperties: false },
)

export const ReadAgentBoardSchema = Type.Object(
	{
		since_id: Type.Optional(Type.String()),
		kind: Type.Optional(
			Type.Enum({
				note: "note" as const,
				work: "work" as const,
				finding: "finding" as const,
				warning: "warning" as const,
			}),
		),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
	},
	{ additionalProperties: false },
)

export function createAgentMessageExtension(capability: AgentMessageCapability): (pi: ExtensionAPI) => void {
	return (pi) => {
		let lastReadPeerEntryId: string | undefined
		pi.on("tool_execution_end", (event, ctx) => {
			if (event.isError || !isTodoWriteToolName(event.toolName)) return
			if (!pi.getActiveTools().includes(POST_AGENT_NOTE_TOOL_NAME)) return
			const details = event.result.details
			if (!isWriteTodosDetails(details)) return
			const todos = details.todos
			const completed = todos.filter((todo) => todo.status === "completed").length
			const blocked = todos.filter((todo) => todo.status === "blocked").length
			// This is a dated claim snapshot, not completion evidence for the receiving session.
			const lines = todos
				.slice(0, 8)
				.map(
					(todo) =>
						`${todo.id} ${todo.status}: ${todo.content.slice(0, 100)}${todo.note ? ` — ${todo.note.slice(0, 100)}` : ""}`,
				)
			capability.postBoardEntry({
				kind: "work",
				snapshotKey: JSON.stringify([ctx.sessionManager.getSessionId(), details.scope]),
				title: `TODO progress: ${completed}/${todos.length} completed, ${blocked} blocked`,
				body:
					`Worker TODO snapshot; claims require verification. Later snapshots replace earlier status.\n` +
					`Session: ${ctx.sessionManager.getSessionId()}; tool result: ${event.toolCallId}; scope: ${JSON.stringify(details.scope)}\n` +
					lines.join("\n") +
					(todos.length > 8 ? `\n${todos.length - 8} more items omitted.` : ""),
			})
		})
		// Like TODO state, this hint belongs to the current request, not session history.
		pi.on("context", (event) => {
			const messages = event.messages.filter(
				(message) => !(message.role === "custom" && message.customType === "agent-board-state"),
			)
			const board = pi.getActiveTools().includes(READ_AGENT_BOARD_TOOL_NAME)
				? capability.listContacts().board
				: undefined
			if (!board?.latestId || board.latestId === lastReadPeerEntryId) {
				return messages.length === event.messages.length ? undefined : { messages }
			}
			messages.push({
				role: "custom",
				customType: "agent-board-state",
				content: markHarnessSteer(
					`Coordination board: ${board.total} peer posts; latest_id=${board.latestId}.\n` +
						"Read peer findings before dependent work. On your first read, omit since_id. " +
						"On later reads, use the last ID returned by read_agent_board, never an ID from your own post. " +
						"If repeated reads miss latest_id, omit since_id to recover. Verify peer claims against their evidence.",
				),
				display: false,
				timestamp: Date.now(),
			})
			return { messages }
		})

		pi.registerTool(
			defineTool({
				name: LIST_AGENT_CONTACTS_TOOL_NAME,
				label: "List Agent Contacts",
				description:
					"List recipients the host currently authorizes for this agent. Call again if peer state may have changed.",
				parameters: Type.Object({}, { additionalProperties: false }),
				execute: async () => textResult(JSON.stringify(capability.listContacts())),
			}),
		)

		pi.registerTool(
			defineTool({
				name: SEND_AGENT_MESSAGE_TOOL_NAME,
				label: "Send Agent Message",
				description:
					"Send one focused message to an authorized contact. A receipt proves only host queue acceptance or a completed bounded resume attempt; it does not prove delivery or recipient action.",
				parameters: AgentMessageToolSchema,
				execute: async (toolCallId, params) => {
					let input: unknown = params
					if (Value.Check(AgentMessageToolSchema, params) && "reply_to" in params.payload) {
						const { reply_to, ...payload } = params.payload
						if (reply_to !== undefined) {
							if (params.reply_to !== undefined && params.reply_to !== reply_to) {
								throw new Error("Conflicting reply_to values. Supply the same exact open question ID in one location.")
							}
							input = { ...params, payload, reply_to }
						}
					}
					const validated = validateAgentMessageInput(input)
					if (!validated.valid) throw new Error(validated.reason)
					const receipt = await capability.sendMessage(toolCallId, validated.value)
					if (receipt.status === "unavailable" && validated.value.recipient.type === "agent" && !receipt.escapeHatch) {
						return agentMessageResult({
							...receipt,
							escapeHatch:
								"Call list_agent_contacts and use its exact agent_id, not a role name. If the peer is absent, report the unresolved dependency to the parent.",
						})
					}
					return agentMessageResult(receipt)
				},
			}),
		)

		pi.registerTool(
			defineTool({
				name: POST_AGENT_NOTE_TOOL_NAME,
				label: "Post Agent Note",
				description:
					"Post a note/work/finding/warning to the shared coordination board for the agent group. " +
					"Manual posts are append-only; automatic TODO snapshots keep the latest progress. Use send_agent_message for directed 1:1 communication.",
				parameters: PostAgentNoteSchema,
				execute: async (_toolCallId, params) => {
					if (!Value.Check(PostAgentNoteSchema, params)) {
						throw new Error(JSON.stringify({ ok: false, reason: "invalid_schema" }))
					}
					return agentBoardResult(capability.postBoardEntry(params))
				},
			}),
		)

		pi.registerTool(
			defineTool({
				name: READ_AGENT_BOARD_TOOL_NAME,
				label: "Read Agent Board",
				description:
					"Read new board entries since an id, filtered by kind, up to a limit. " +
					"Returns only authorized entries for the caller's group. " +
					"Omit since_id on your first read; on later reads, use the last ID returned by this tool.",
				parameters: ReadAgentBoardSchema,
				execute: async (_toolCallId, params) => {
					if (!Value.Check(ReadAgentBoardSchema, params)) {
						throw new Error(JSON.stringify({ ok: false, reason: "invalid_schema" }))
					}
					const opts: Parameters<typeof capability.readBoardEntries>[0] = {
						sinceId: params.since_id,
						kind: params.kind,
						limit: params.limit,
					}
					const result = capability.readBoardEntries(opts)
					if (result.ok && !params.kind) {
						const latestId = capability.listContacts().board?.latestId
						if (latestId && result.entries.some((entry) => entry.id === latestId)) lastReadPeerEntryId = latestId
					}
					return agentBoardResult(result)
				},
			}),
		)
	}
}
