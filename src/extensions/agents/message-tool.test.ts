import { validateToolArguments } from "@earendil-works/pi-ai"
import type { ContextEvent, ToolExecutionEndEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { applyWriteTodos } from "../todos/store.js"
import { UPDATE_TODOS_TOOL_NAME } from "../todos/tool.js"
import {
	type AgentMessageCapability,
	createAgentMessageExtension,
	LIST_AGENT_CONTACTS_TOOL_NAME,
	POST_AGENT_NOTE_TOOL_NAME,
	READ_AGENT_BOARD_TOOL_NAME,
	SEND_AGENT_MESSAGE_TOOL_NAME,
} from "./message-tool.js"

function makePi() {
	const mock = createExtensionApi()
	const tools: Array<{ name: string; execute: (id: string, params?: unknown) => Promise<unknown> }> = []
	vi.mocked(mock.api.registerTool).mockImplementation((tool) => {
		tools.push({
			name: tool.name,
			execute: (id, params = {}) => tool.execute(id, params, undefined, undefined, createContext()),
		})
	})
	return {
		...mock,
		pi: mock.api,
		tools,
	}
}

describe("agent communication child tools", () => {
	it("publishes successful TODO snapshots including reopened evidence, with local provenance", async () => {
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const mock = makePi()
		createAgentMessageExtension(capability)(mock.pi)
		const ctx = createContext()
		const handler = mock.getHandler<ToolExecutionEndEvent>("tool_execution_end")
		for (const status of ["completed", "in_progress"] as const) {
			const details = applyWriteTodos(
				{ todos: [{ content: "Check shared contract", status, note: "Evidence: contract test result" }] },
				ctx.sessionManager.getSessionId(),
			)
			await handler(
				{
					type: "tool_execution_end",
					toolName: UPDATE_TODOS_TOOL_NAME,
					toolCallId: `todo-${status}`,
					isError: false,
					result: { content: [], details },
				},
				ctx,
			)
		}
		expect(capability.postBoardEntry).toHaveBeenCalledTimes(2)
		expect(capability.postBoardEntry).toHaveBeenLastCalledWith(
			expect.objectContaining({
				title: "TODO progress: 0/1 completed, 0 blocked",
				body: expect.stringContaining("todo-in_progress"),
			}),
		)
		expect(vi.mocked(capability.postBoardEntry).mock.calls[0][0].body).toContain("Evidence: contract test result")
		await handler(
			{
				type: "tool_execution_end",
				toolName: UPDATE_TODOS_TOOL_NAME,
				toolCallId: "failed",
				isError: true,
				result: { content: [], details: {} },
			},
			ctx,
		)
		expect(capability.postBoardEntry).toHaveBeenCalledTimes(2)
	})

	it.each([
		{ kind: "answer", answer: "Use the existing-index helper." },
		{ kind: "decline", reason: "That module belongs to another worker." },
	])("normalizes an explicit reply ID inside a $kind payload after SDK coercion", async (payload) => {
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(),
			sendMessage: vi.fn().mockResolvedValue({ status: "queued_for_running_session", messageId: "reply" }),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi } = makePi()
		createAgentMessageExtension(capability)(pi)
		const tool = vi.mocked(pi.registerTool).mock.calls.find(([tool]) => tool.name === SEND_AGENT_MESSAGE_TOOL_NAME)?.[0]
		if (!tool) throw new Error("Missing send tool")
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "nested-reply",
			name: tool.name,
			arguments: {
				recipient: JSON.stringify({ type: "agent", agentId: "peer" }),
				payload: JSON.stringify({ ...payload, reply_to: "question-1" }),
			},
		})
		await tool.execute("nested-reply", args, undefined, undefined, createContext())
		expect(capability.sendMessage).toHaveBeenCalledExactlyOnceWith("nested-reply", {
			recipient: { type: "agent", agentId: "peer" },
			payload,
			reply_to: "question-1",
		})
		expect(args).toHaveProperty("payload.reply_to", "question-1")
	})

	it.each([
		{ outerId: "question-1", accepted: true },
		{ outerId: "different-question", accepted: false },
	])("handles reply IDs in both locations without choosing between them: $outerId", async ({ outerId, accepted }) => {
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(),
			sendMessage: vi.fn().mockResolvedValue({ status: "queued_for_running_session", messageId: "reply" }),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi } = makePi()
		createAgentMessageExtension(capability)(pi)
		const tool = vi.mocked(pi.registerTool).mock.calls.find(([tool]) => tool.name === SEND_AGENT_MESSAGE_TOOL_NAME)?.[0]
		if (!tool) throw new Error("Missing send tool")
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "two-ids",
			name: tool.name,
			arguments: {
				recipient: { type: "agent", agentId: "peer" },
				payload: { kind: "answer", answer: "Confirmed.", reply_to: "question-1" },
				reply_to: outerId,
			},
		})
		const result = tool.execute("two-ids", args, undefined, undefined, createContext())
		if (accepted) {
			await result
			expect(capability.sendMessage).toHaveBeenCalledExactlyOnceWith("two-ids", {
				recipient: { type: "agent", agentId: "peer" },
				payload: { kind: "answer", answer: "Confirmed." },
				reply_to: "question-1",
			})
		} else {
			await expect(result).rejects.toThrow("Conflicting reply_to values")
			expect(capability.sendMessage).not.toHaveBeenCalled()
		}
	})

	it.each(["parent", "user"])("does not permit nested-ID answers to a %s recipient", async (type) => {
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi } = makePi()
		createAgentMessageExtension(capability)(pi)
		const tool = vi.mocked(pi.registerTool).mock.calls.find(([tool]) => tool.name === SEND_AGENT_MESSAGE_TOOL_NAME)?.[0]
		if (!tool) throw new Error("Missing send tool")
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "invalid-route",
			name: tool.name,
			arguments: {
				recipient: { type },
				payload: { kind: "answer", answer: "Confirmed.", reply_to: "question-1" },
			},
		})
		await expect(tool.execute("invalid-route", args, undefined, undefined, createContext())).rejects.toThrow(
			"Message must use one supported recipient and payload combination",
		)
		expect(capability.sendMessage).not.toHaveBeenCalled()
	})

	it("explains a question carrying reply_to after SDK argument coercion without sending it", async () => {
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi } = makePi()
		createAgentMessageExtension(capability)(pi)
		const tool = vi.mocked(pi.registerTool).mock.calls.find(([tool]) => tool.name === SEND_AGENT_MESSAGE_TOOL_NAME)?.[0]
		if (!tool) throw new Error("Missing send tool")
		const args = validateToolArguments(tool, {
			type: "toolCall",
			id: "bad-question",
			name: tool.name,
			arguments: {
				recipient: JSON.stringify({ type: "agent", agentId: "peer" }),
				payload: JSON.stringify({
					kind: "question",
					question: "Expires at the boundary?",
					impact: "Defines the predicate",
					canContinue: true,
				}),
				reply_to: "another-question",
			},
		})
		await expect(tool.execute("bad-question", args, undefined, undefined, createContext())).rejects.toThrow(
			"Remove reply_to from this question",
		)
		expect(capability.sendMessage).not.toHaveBeenCalled()
	})
	it("refreshes the authorized board hint between model calls without reading bodies or persisting messages", async () => {
		let board: { total: number; latestId?: string } | undefined
		const capability: AgentMessageCapability = {
			listContacts: () => ({ parent: { reachable: true }, user_via_parent: { reachable: false }, peers: [], board }),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const mock = makePi()
		createAgentMessageExtension(capability)(mock.pi)
		const context = mock.getHandler<ContextEvent, Partial<Pick<ContextEvent, "messages">>>("context")
		const messages: ContextEvent["messages"] = [{ role: "user", content: "Do the task", timestamp: 1 }]
		const ctx = createContext()
		expect(await context({ type: "context", messages }, ctx)).toBeUndefined()

		board = { total: 1, latestId: "bd-first" }
		const first = await context({ type: "context", messages }, ctx)
		expect(first?.messages).toHaveLength(2)
		expect(first?.messages?.[1]).toMatchObject({
			role: "custom",
			customType: "agent-board-state",
			content: expect.stringContaining("latest_id=bd-first"),
			display: false,
		})
		expect(messages).toHaveLength(1)

		board = { total: 2, latestId: "bd-second" }
		const second = await context({ type: "context", messages: first?.messages ?? messages }, ctx)
		expect(second?.messages).toHaveLength(2)
		expect(second?.messages?.[1]).toMatchObject({ content: expect.stringContaining("latest_id=bd-second") })

		board = undefined
		expect(await context({ type: "context", messages: second?.messages ?? messages }, ctx)).toEqual({ messages })
		board = { total: 2, latestId: "bd-second" }
		vi.mocked(mock.api.getActiveTools).mockReturnValue(["list_agent_contacts", "send_agent_message"])
		expect(await context({ type: "context", messages }, ctx)).toBeUndefined()
		expect(capability.readBoardEntries).not.toHaveBeenCalled()
		expect(mock.sendMessage).not.toHaveBeenCalled()
		expect(mock.appendEntry).not.toHaveBeenCalled()
	})

	it("binds all four tools", () => {
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(() => ({
				parent: { reachable: true },
				user_via_parent: { reachable: false, route: "unavailable" as const },
				peers: [],
			})),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		expect(tools.map((tool) => tool.name)).toEqual([
			LIST_AGENT_CONTACTS_TOOL_NAME,
			SEND_AGENT_MESSAGE_TOOL_NAME,
			POST_AGENT_NOTE_TOOL_NAME,
			READ_AGENT_BOARD_TOOL_NAME,
		])
	})

	it("contacts list includes board hint when capability has board entries", async () => {
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(() => ({
				parent: { reachable: true },
				user_via_parent: { reachable: false, route: "unavailable" as const },
				peers: [],
				board: { total: 3, latestId: "bd-abc123" },
			})),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		const result = await tools[0]?.execute("tool-call")
		expect(result).toBeDefined()
		const text =
			typeof result === "object" && result !== null && "content" in result
				? (result as { content: Array<{ text: string }> }).content[0]?.text
				: ""
		expect(text).toContain('"board":{"total":3,"latestId":"bd-abc123"}')
		expect(capability.listContacts).toHaveBeenCalledOnce()
	})

	it("contacts list omits board when capability has no entries", async () => {
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(() => ({
				parent: { reachable: true },
				user_via_parent: { reachable: false, route: "unavailable" as const },
				peers: [],
			})),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		const result = await tools[0]?.execute("tool-call")
		expect(result).toBeDefined()
		const text =
			typeof result === "object" && result !== null && "content" in result
				? (result as { content: Array<{ text: string }> }).content[0]?.text
				: ""
		expect(text).not.toContain('"board"')
	})

	it("validates input before invoking the host send callback", async () => {
		const sendMessage = vi.fn().mockResolvedValue({ status: "queued_for_parent" })
		const capability: AgentMessageCapability = {
			listContacts: () => ({
				parent: { reachable: true },
				user_via_parent: { reachable: false, route: "unavailable" as const },
				peers: [],
			}),
			sendMessage,
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		await expect(
			tools[1]?.execute("tool-call", {
				recipient: { type: "user" },
				payload: { kind: "status", summary: "not allowed for user" },
			}),
		).rejects.toThrow("Message must use")
		expect(sendMessage).not.toHaveBeenCalled()
	})

	it.each([
		"queued_for_parent",
		"queued_before_session",
		"queued_for_running_session",
		"resume_attempt_completed",
	] as const)("returns a successful %s receipt without claiming delivery", async (status) => {
		const sendMessage = vi.fn().mockResolvedValue({ status, messageId: "m1", threadId: "m1" })
		const capability: AgentMessageCapability = {
			listContacts: () => ({
				parent: { reachable: true },
				user_via_parent: { reachable: false, route: "unavailable" as const },
				peers: [],
			}),
			sendMessage,
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		const result = await tools[1]?.execute("tool-call", {
			recipient: { type: "parent" },
			payload: { kind: "status", summary: "progress" },
		})

		expect(sendMessage).toHaveBeenCalledWith("tool-call", expect.objectContaining({ recipient: { type: "parent" } }))
		expect(result).toMatchObject({
			content: [{ type: "text", text: JSON.stringify({ status, messageId: "m1", threadId: "m1" }) }],
		})
	})

	it.each([
		"rejected",
		"unavailable",
		"saturated",
	] as const)("reports a %s send as a tool error without losing correction details", async (status) => {
		const receipt = {
			status,
			reason: "No answer was sent.",
			openQuestionIds: ["authorized-question"],
			escapeHatch: "Continue independent work.",
		}
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(),
			sendMessage: vi.fn().mockResolvedValue(receipt),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		await expect(
			tools[1]?.execute("reply-call", {
				recipient: { type: "agent", agentId: "peer" },
				payload: { kind: "answer", answer: "Use the shared contract." },
				reply_to: "wrong-question",
			}),
		).rejects.toThrow(JSON.stringify(receipt))
		expect(capability.sendMessage).toHaveBeenCalledOnce()
	})

	it("post_agent_note calls postBoardEntry with the capability", async () => {
		const postBoardEntry = vi.fn().mockReturnValue({
			ok: true as const,
			entry: { id: "bd-1234", kind: "note", title: "Test", body: "body", authorAgentId: "agent-1" },
			truncated: [],
		})
		const capability: AgentMessageCapability = {
			listContacts: () => ({
				parent: { reachable: true },
				user_via_parent: { reachable: false, route: "unavailable" as const },
				peers: [],
			}),
			sendMessage: vi.fn(),
			postBoardEntry,
			readBoardEntries: vi.fn(),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		const result = await tools[2]?.execute("tool-call", {
			kind: "note",
			title: "Test note",
			body: "Body",
		})

		expect(postBoardEntry).toHaveBeenCalledWith({ kind: "note", title: "Test note", body: "Body" })
		expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining('"ok":true') }] })
	})

	it.each([
		{ index: 2, params: { kind: "invalid", title: "Test", body: "Body" } },
		{ index: 3, params: { limit: 0 } },
	])("rejects invalid board arguments without calling the host ($index)", async ({ index, params }) => {
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn(),
			readBoardEntries: vi.fn(),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)
		await expect(tools[index]?.execute("invalid-board", params)).rejects.toThrow(
			JSON.stringify({ ok: false, reason: "invalid_schema" }),
		)
		expect(capability.postBoardEntry).not.toHaveBeenCalled()
		expect(capability.readBoardEntries).not.toHaveBeenCalled()
	})

	it("read_agent_board passes since_id and kind filters", async () => {
		const readBoardEntries = vi.fn().mockReturnValue({
			ok: true as const,
			entries: [{ id: "bd-456", kind: "work", title: "Work", body: "done" }],
			total: 1,
		})
		const capability: AgentMessageCapability = {
			listContacts: () => ({
				parent: { reachable: true },
				user_via_parent: { reachable: false, route: "unavailable" as const },
				peers: [],
			}),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn(),
			readBoardEntries,
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)

		const result = await tools[3]?.execute("tool-call", {
			since_id: "bd-123",
			kind: "work",
			limit: 10,
		})

		expect(readBoardEntries).toHaveBeenCalledWith({
			sinceId: "bd-123",
			kind: "work",
			limit: 10,
		})
		expect(result).toMatchObject({ content: [{ type: "text", text: expect.stringContaining('"ok":true') }] })
	})

	it.each([
		"not_authorized_for_board",
		"agent_not_live",
	] as const)("reports rejected board reads and posts as tool errors: %s", async (reason) => {
		const receipt = { ok: false, reason }
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn().mockReturnValue(receipt),
			readBoardEntries: vi.fn().mockReturnValue(receipt),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)
		await expect(tools[2]?.execute("post", { kind: "note", title: "Test", body: "Body" })).rejects.toThrow(
			JSON.stringify(receipt),
		)
		await expect(tools[3]?.execute("read", {})).rejects.toThrow(JSON.stringify(receipt))
		expect(capability.postBoardEntry).toHaveBeenCalledOnce()
		expect(capability.readBoardEntries).toHaveBeenCalledOnce()
	})

	it("keeps empty reads and deduplicated or truncated posts successful", async () => {
		const entry = {
			id: "bd-1",
			rootSessionId: "root",
			groupId: "group",
			authorAgentId: "agent",
			kind: "note" as const,
			title: "Test",
			body: "Body",
			postedAt: 1,
		}
		const empty = { ok: true, entries: [], total: 0 }
		const truncated = { ok: true, entry, truncated: ["body"] }
		const deduped = { ok: true, entry, deduped: true }
		const capability: AgentMessageCapability = {
			listContacts: vi.fn(),
			sendMessage: vi.fn(),
			postBoardEntry: vi.fn().mockReturnValueOnce(truncated).mockReturnValueOnce(deduped),
			readBoardEntries: vi.fn().mockReturnValue(empty),
		}
		const { pi, tools } = makePi()
		createAgentMessageExtension(capability)(pi)
		for (const receipt of [truncated, deduped]) {
			await expect(tools[2]?.execute("post", { kind: "note", title: "Test", body: "Body" })).resolves.toEqual({
				content: [{ type: "text", text: JSON.stringify(receipt) }],
				details: {},
			})
		}
		await expect(tools[3]?.execute("read", {})).resolves.toEqual({
			content: [{ type: "text", text: JSON.stringify(empty) }],
			details: {},
		})
	})
})
