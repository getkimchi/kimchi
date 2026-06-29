import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import todosExtension, {
	TODO_BLOCKED_QUESTIONS_MESSAGE,
	TODO_CHECKPOINT_MESSAGE,
	TODO_RECONCILE_MESSAGE,
} from "./index.js"
import { __resetTodoStore, applyWriteTodos, getTodosForScope, registerActiveTodoScopeProvider } from "./store.js"
import { TODO_TOOL_NAMES, UPDATE_TODOS_TOOL_NAME } from "./tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type TodoStatus } from "./types.js"

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme

function createTodosHarness() {
	const handlers = new Map<string, ExtensionHandler[]>()
	const pi = {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		getActiveTools: vi.fn(() => [...TODO_TOOL_NAMES]),
		on: vi.fn((event: string, handler: ExtensionHandler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
	} as unknown as ExtensionAPI

	todosExtension(pi)

	return {
		async fire(event: string, payload: unknown, ctx: ExtensionContext) {
			let result: unknown
			for (const handler of handlers.get(event) ?? []) {
				result = await handler(payload, ctx)
			}
			return result
		},
		appendEntry: pi.appendEntry,
		sendMessage: pi.sendMessage,
	}
}

function createContext(
	sessionId: string,
	branch: SessionEntry[],
	options: { hasPendingMessages?: boolean; hasUI?: boolean; ui?: ExtensionContext["ui"] } = {},
): ExtensionContext {
	return {
		hasUI: options.hasUI ?? false,
		cwd: "/test",
		ui: options.ui,
		hasPendingMessages: () => options.hasPendingMessages ?? false,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext
}

function terminalTurn(stopReason = "end_turn"): unknown {
	return { message: { role: "assistant", content: [], stopReason }, toolResults: [] }
}

function terminalTurnWithText(text = "Done."): unknown {
	return { message: { role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" }, toolResults: [] }
}

function toolCall(toolName: string): unknown {
	return {
		type: "tool_call",
		toolCallId: `call-${toolName}`,
		toolName,
		input: toolName === "bash" ? { command: "ls" } : {},
	}
}

function writeTodosEntry(
	id: string,
	content: string,
	status: TodoStatus = "pending",
	toolName: string = UPDATE_TODOS_TOOL_NAME,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: `tool-${id}`,
			toolName,
			content: [{ type: "text", text: "Updated 1 todos." }],
			details: {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope: { kind: "global" },
				todos: [{ id: 1, content, status }],
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		},
	} as unknown as SessionEntry
}

function customTodosEntry(id: string, content: string, status: TodoStatus = "pending"): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType: TODO_CUSTOM_ENTRY_TYPE,
		data: {
			schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
			scope: { kind: "global" },
			todos: [{ id: 1, content, status }],
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	} as unknown as SessionEntry
}

describe("todos extension session state", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("restores todos from the active session branch instead of the previous store", async () => {
		const harness = createTodosHarness()
		applyWriteTodos({ todos: [{ content: "stale previous session", status: "pending" }] })

		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("resumed-session", [
				writeTodosEntry("a", "superseded resumed todo"),
				writeTodosEntry("b", "current resumed todo", "in_progress"),
			]),
		)

		expect(getTodosForScope().map((todo) => todo.content)).toEqual(["current resumed todo"])
	})

	it("clears stale todos when the replacement session has no todo history", async () => {
		const harness = createTodosHarness()
		applyWriteTodos({ todos: [{ content: "stale previous session", status: "pending" }] })

		await harness.fire("session_start", { reason: "fork" }, createContext("forked-session", []))

		expect(getTodosForScope()).toEqual([])
	})

	it("replays todos when the active session tree branch changes", async () => {
		const harness = createTodosHarness()
		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("session", [writeTodosEntry("a", "root todo")]),
		)

		expect(getTodosForScope().map((todo) => todo.content)).toEqual(["root todo"])

		await harness.fire(
			"session_tree",
			{ oldLeafId: "a", newLeafId: "b" },
			createContext("session", [writeTodosEntry("b", "branch todo", "in_progress")]),
		)

		expect(getTodosForScope().map((todo) => todo.content)).toEqual(["branch todo"])
	})

	it("restores slash-command todo edits from custom entries", async () => {
		const harness = createTodosHarness()

		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("session", [customTodosEntry("c", "command todo")]),
		)

		expect(getTodosForScope().map((todo) => todo.content)).toEqual(["command todo"])
	})

	it("restores todos from every todo tool result", async () => {
		for (const toolName of TODO_TOOL_NAMES) {
			__resetTodoStore()
			const harness = createTodosHarness()

			await harness.fire(
				"session_start",
				{ reason: "resume" },
				createContext("session", [writeTodosEntry("u", `${toolName} todo`, "completed", toolName)]),
			)

			expect(getTodosForScope().map((todo) => todo.content)).toEqual([`${toolName} todo`])
			expect(getTodosForScope()[0]?.status).toBe("completed")
		}
	})

	it("restores todos from legacy write_todos tool results", async () => {
		const harness = createTodosHarness()

		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("session", [writeTodosEntry("legacy", "legacy todo", "in_progress", "write_todos")]),
		)

		expect(getTodosForScope().map((todo) => todo.content)).toEqual(["legacy todo"])
		expect(getTodosForScope()[0]?.status).toBe("in_progress")
	})

	it("adds todo guidance to a system prompt that missed extension prompt blocks", async () => {
		const harness = createTodosHarness()
		const result = (await harness.fire(
			"before_agent_start",
			{ systemPrompt: "## Tools\n- read" },
			createContext("session", []),
		)) as { systemPrompt?: string }

		expect(result.systemPrompt).toContain("## Todos")
	})

	it("does not inject hidden todo steers for non-todo tool calls", async () => {
		const harness = createTodosHarness()
		const result = await harness.fire("tool_call", toolCall("bash"), createContext("session", []))

		expect(result).toBeUndefined()
		expect(harness.appendEntry).not.toHaveBeenCalled()
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("keeps injecting process checkpoints after successful non-todo work until todos are updated", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "check work", status: "in_progress" }] })
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)

		const result = (await harness.fire("context", { messages: [] }, ctx)) as {
			messages: Array<{ customType: string; display: boolean; details: unknown; content: Array<{ text: string }> }>
		}
		const checkpoint = result.messages[0]
		expect(checkpoint.customType).toBe(TODO_CUSTOM_ENTRY_TYPE)
		expect(checkpoint.display).toBe(false)
		expect(checkpoint.details).toEqual({ reason: "todo_checkpoint" })
		expect(checkpoint.content[0].text).toContain(TODO_CHECKPOINT_MESSAGE)
		expect(checkpoint.content[0].text).toContain("impossible")
		expect(checkpoint.content[0].text).toContain("blocked")
		expect(checkpoint.content[0].text).toContain("#1 [in_progress] check work")
		const repeated = (await harness.fire("context", { messages: [] }, ctx)) as {
			messages: Array<{ details: unknown; content: Array<{ text: string }> }>
		}
		expect(repeated.messages[0].details).toEqual({ reason: "todo_checkpoint" })
		expect(repeated.messages[0].content[0].text).toContain("#1 [in_progress] check work")
	})

	it("clears checkpoint pressure after a todo write", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "check work", status: "in_progress" }] })
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		applyWriteTodos({ todos: [{ id: 1, content: "check work", status: "completed" }] })

		expect(await harness.fire("context", { messages: [] }, ctx)).toBeUndefined()
	})

	it("queues reconciliation follow-ups after visible terminal stops", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "still active", status: "in_progress" }] })
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)
		await harness.fire("input", { type: "input", text: "", source: "extension", streamingBehavior: "followUp" }, ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)

		expect(harness.sendMessage).toHaveBeenCalledTimes(2)
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: TODO_CUSTOM_ENTRY_TYPE,
				content: [
					{
						type: "text",
						text: expect.stringContaining(TODO_RECONCILE_MESSAGE),
					},
				],
				display: false,
				details: { reason: "reconcile_todos" },
			},
			{ deliverAs: "followUp" },
		)
		const reconcileMessage = vi.mocked(harness.sendMessage).mock.calls[0]?.[0] as {
			content: Array<{ text: string }>
		}
		expect(reconcileMessage.content[0].text).toContain("impossible")
		expect(reconcileMessage.content[0].text).toContain("blocked")
		const checkpoint = (await harness.fire("context", { messages: [] }, ctx)) as {
			messages: Array<{ details: unknown; content: Array<{ text: string }> }>
		}
		expect(checkpoint.messages[0].details).toEqual({ reason: "todo_checkpoint" })
		expect(checkpoint.messages[0].content[0].text).toContain("still active")

		applyWriteTodos({ todos: [{ id: 1, content: "still active", status: "completed" }] })
		await harness.fire("turn_end", terminalTurn(), ctx)
		expect(harness.sendMessage).toHaveBeenCalledTimes(2)
	})

	it("does not send a reconciliation follow-up after an empty visible stop", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "still active", status: "in_progress" }] })
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		await harness.fire("turn_end", terminalTurn("stop"), ctx)

		expect(harness.sendMessage).not.toHaveBeenCalled()
		const checkpoint = (await harness.fire("context", { messages: [] }, ctx)) as {
			messages: Array<{ details: unknown; content: Array<{ text: string }> }>
		}
		expect(checkpoint.messages[0].details).toEqual({ reason: "todo_checkpoint" })
		expect(checkpoint.messages[0].content[0].text).toContain("still active")
	})

	it("suppresses premature final assistant text while stale todos remain", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "report package name", status: "in_progress" }] })
		await harness.fire("tool_execution_end", { toolName: "read", isError: false }, ctx)

		const message = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "@kimchi-dev/cli" }],
			stopReason: "stop",
		}

		await harness.fire("message_update", { message, assistantMessageEvent: {} }, ctx)
		expect(message.content[0].text).toBe("")

		message.content[0].text = "@kimchi-dev/cli"
		const result = (await harness.fire("message_end", { message }, ctx)) as {
			message?: { content: unknown[] }
		}
		expect(message.content[0].text).toBe("")
		expect(result.message?.content).toEqual([])

		await harness.fire("turn_end", { message, toolResults: [] }, ctx)
		expect(harness.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				details: { reason: "reconcile_todos" },
				content: [expect.objectContaining({ text: expect.stringContaining("report package name") })],
			}),
			{ deliverAs: "followUp" },
		)
	})

	it("does not reconcile immediately after only writing todos", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "new plan", status: "pending" }] })
		await harness.fire("turn_end", terminalTurn(), ctx)

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("resyncs the active todo widget on terminal turns after the TUI clears widgets", async () => {
		const harness = createTodosHarness()
		const setWidget = vi.fn()
		const ctx = createContext("session", [], {
			hasUI: true,
			ui: { theme, setWidget, setStatus: vi.fn() } as unknown as ExtensionContext["ui"],
		})
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "visible active todo", status: "in_progress" }] })
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		instance.dispose()

		await harness.fire("turn_end", terminalTurn(), ctx)

		expect(setWidget).toHaveBeenCalledTimes(2)
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("queues a questionnaire follow-up for blocked todos with question notes", async () => {
		const harness = createTodosHarness()
		const custom = vi.fn(async () => ({ questions: [], answers: [], cancelled: true }))
		const ctx = createContext("session", [], {
			hasUI: true,
			ui: {
				theme,
				setWidget: vi.fn(),
				setStatus: vi.fn(),
				custom,
			} as unknown as ExtensionContext["ui"],
		})
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({
			todos: [
				{
					id: 1,
					content: "Get approval code",
					status: "blocked",
					note: JSON.stringify({ question: { label: "Approval code", type: "text" } }),
				},
				{
					id: 2,
					content: "Pick target environment",
					status: "blocked",
					note: JSON.stringify({
						question: { label: "Target", type: "single", options: ["Production", { id: "staging", label: "Staging" }] },
					}),
				},
			],
		})

		await harness.fire("turn_end", terminalTurnWithText("Need input."), ctx)

		expect(custom).not.toHaveBeenCalled()
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: TODO_CUSTOM_ENTRY_TYPE,
				content: [{ type: "text", text: expect.stringContaining(TODO_BLOCKED_QUESTIONS_MESSAGE) }],
				display: false,
				details: { reason: "blocked_todo_questions" },
			},
			{ deliverAs: "followUp" },
		)
		const message = vi.mocked(harness.sendMessage).mock.calls[0]?.[0] as { content: Array<{ text: string }> }
		expect(message.content[0].text).toContain('"header":"Blocked todos need your input"')
		expect(message.content[0].text).toContain('"id":"todo_1"')
		expect(message.content[0].text).toContain('"prompt":"Please provide: Get approval code"')
		expect(message.content[0].text).toContain('"type":"single"')
		expect(message.content[0].text).toContain('"id":"staging"')
	})

	it("does not repeat the same blocked todo question follow-up", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({
			todos: [
				{
					id: 1,
					content: "Get approval code",
					status: "blocked",
					note: JSON.stringify({ question: { label: "Approval code", type: "text" } }),
				},
			],
		})

		await harness.fire("turn_end", terminalTurnWithText("Need input."), ctx)
		await harness.fire("turn_end", terminalTurnWithText("Still need input."), ctx)

		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("queues ask-now blocked todo questions immediately after todo writes", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({
			todos: [
				{
					id: 1,
					content: "Get production approval",
					status: "blocked",
					note: JSON.stringify({ ask: "now", question: { label: "Approval", type: "text" } }),
				},
			],
		})

		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: TODO_CUSTOM_ENTRY_TYPE,
				content: [{ type: "text", text: expect.stringContaining(TODO_BLOCKED_QUESTIONS_MESSAGE) }],
				display: false,
				details: { reason: "blocked_todo_questions" },
			},
			{ deliverAs: "followUp" },
		)
		const message = vi.mocked(harness.sendMessage).mock.calls[0]?.[0] as { content: Array<{ text: string }> }
		expect(message.content[0].text).toContain('"id":"todo_1"')
		expect(message.content[0].text).toContain('"prompt":"Please provide: Get production approval"')
	})

	it("does not auto-ask later-policy blocked todo questions", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({
			todos: [
				{
					id: 1,
					content: "Capture nice-to-have metric",
					status: "blocked",
					note: JSON.stringify({ ask: "later", question: { label: "Metric", type: "text" } }),
				},
			],
		})
		await harness.fire("turn_end", terminalTurnWithText("Done for now."), ctx)

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("does not route non-global blocked todo questions through questionnaire", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		registerActiveTodoScopeProvider(() => ({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" }))
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({
			todos: [
				{
					id: 1,
					content: "Ask ferment question",
					status: "blocked",
					note: JSON.stringify({ ask: "now", question: { label: "Ferment blocker", type: "text" } }),
				},
			],
		})
		await harness.fire("turn_end", terminalTurnWithText("Ferment is blocked."), ctx)

		expect(harness.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ details: { reason: "blocked_todo_questions" } }),
			expect.anything(),
		)
	})

	it("does not queue blocker questions for blocked todos without question notes", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ id: 1, content: "Get approval code", status: "blocked" }] })

		await harness.fire("turn_end", terminalTurnWithText("Need input."), ctx)

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("does not reconcile on non-terminal turns", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "still active", status: "in_progress" }] })
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)

		await harness.fire("turn_end", { message: { role: "assistant", stopReason: "aborted" }, toolResults: [] }, ctx)
		await harness.fire("turn_end", { message: { role: "assistant" }, toolResults: [{}] }, ctx)
		await harness.fire("turn_end", terminalTurn(), createContext("session", [], { hasPendingMessages: true }))

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})
})
