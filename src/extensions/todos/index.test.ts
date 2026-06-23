import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import todosExtension, { TODO_CLEANUP_MESSAGE, TODO_OPEN_REMINDER_TYPE, buildOpenTodosReminder } from "./index.js"
import { __resetTodoStore, applyWriteTodos, getTodosForScope } from "./store.js"
import { TODO_TOOL_NAMES, UPDATE_TODOS_TOOL_NAME } from "./tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type TodoStatus } from "./types.js"

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

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

function createContext(sessionId: string, branch: SessionEntry[]): ExtensionContext {
	return {
		hasUI: false,
		cwd: "/test",
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext
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

// ---------------------------------------------------------------------------
// Pi mock factory for input handler tests (does NOT call todosExtension)
// ---------------------------------------------------------------------------

type InputHandler = (event: { source: string }) => unknown

function createInputHarness() {
	const handlers = new Map<string, InputHandler[]>()
	const sendMessage = vi.fn()
	const pi = {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage,
		getActiveTools: vi.fn(() => [...TODO_TOOL_NAMES]),
		on: vi.fn((event: string, handler: InputHandler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
	} as unknown as ExtensionAPI

	return {
		pi,
		handlers,
		sendMessage,
		fireInput(source: string) {
			for (const h of handlers.get("input") ?? []) h({ source })
		},
	}
}

// ---------------------------------------------------------------------------
// buildOpenTodosReminder
// ---------------------------------------------------------------------------

describe("buildOpenTodosReminder", () => {
	it("uses singular wording for 1 open item", () => {
		expect(buildOpenTodosReminder(1)).toContain("1 open todo item")
		expect(buildOpenTodosReminder(1)).not.toContain("1 open todo items")
	})

	it("uses plural wording for 2 open items", () => {
		expect(buildOpenTodosReminder(2)).toContain("2 open todo items")
	})

	it("uses plural wording for larger counts", () => {
		expect(buildOpenTodosReminder(5)).toContain("5 open todo items")
	})

	it("contains clear_todos", () => {
		expect(buildOpenTodosReminder(1)).toContain("clear_todos")
		expect(buildOpenTodosReminder(3)).toContain("clear_todos")
	})
})

// ---------------------------------------------------------------------------
// open-todos input handler (spicy variant, main session only)
// ---------------------------------------------------------------------------

describe("todos open-reminder input handler", () => {
	let savedVariant: string | undefined
	let savedSubagent: string | undefined

	beforeEach(() => {
		savedVariant = process.env.KIMCHI_PROMPT_VARIANT
		process.env.KIMCHI_PROMPT_VARIANT = "spicy"
		__resetTodoStore()
	})

	afterEach(() => {
		if (savedVariant === undefined) {
			Reflect.deleteProperty(process.env, "KIMCHI_PROMPT_VARIANT")
		} else {
			process.env.KIMCHI_PROMPT_VARIANT = savedVariant
		}
		if (savedSubagent === undefined) {
			Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		} else {
			process.env.KIMCHI_SUBAGENT = savedSubagent
		}
		savedSubagent = undefined
	})

	it("sends reminder with correct shape when user input arrives and todos are open", () => {
		applyWriteTodos({
			todos: [
				{ content: "task A", status: "pending" },
				{ content: "task B", status: "pending" },
				{ content: "task C", status: "completed" },
			],
		})
		const { pi, sendMessage, fireInput } = createInputHarness()
		todosExtension(pi)

		fireInput("interactive")

		expect(sendMessage).toHaveBeenCalledOnce()
		const [msg, opts] = sendMessage.mock.calls[0]
		expect(msg.customType).toBe(TODO_OPEN_REMINDER_TYPE)
		expect(msg.display).toBe(false)
		expect(opts).toEqual({ deliverAs: "nextTurn" })
		expect(msg.content).toHaveLength(1)
		expect(msg.content[0].type).toBe("text")
		expect(msg.content[0].text).toContain("2 open todo")
	})

	it("does not send when event.source is 'extension'", () => {
		applyWriteTodos({ todos: [{ content: "task A", status: "pending" }] })
		const { pi, sendMessage, fireInput } = createInputHarness()
		todosExtension(pi)

		fireInput("extension")

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("does not send when all todos are completed", () => {
		applyWriteTodos({ todos: [{ content: "task A", status: "completed" }] })
		const { pi, sendMessage, fireInput } = createInputHarness()
		todosExtension(pi)

		fireInput("interactive")

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("does not send when the store is empty", () => {
		const { pi, sendMessage, fireInput } = createInputHarness()
		todosExtension(pi)

		fireInput("interactive")

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("does not register the input handler and does not send when variant is 'default'", () => {
		process.env.KIMCHI_PROMPT_VARIANT = "default"
		applyWriteTodos({ todos: [{ content: "task A", status: "pending" }] })
		const { pi, handlers, sendMessage, fireInput } = createInputHarness()
		todosExtension(pi)

		expect(handlers.get("input")).toBeUndefined()
		fireInput("interactive")
		expect(sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: TODO_OPEN_REMINDER_TYPE }),
			expect.anything(),
		)
	})

	it("does not send when KIMCHI_PROMPT_VARIANT is unset (resolves to default)", () => {
		Reflect.deleteProperty(process.env, "KIMCHI_PROMPT_VARIANT")
		applyWriteTodos({ todos: [{ content: "task A", status: "pending" }] })
		const { pi, sendMessage, fireInput } = createInputHarness()
		todosExtension(pi)

		fireInput("interactive")

		expect(sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: TODO_OPEN_REMINDER_TYPE }),
			expect.anything(),
		)
	})

	it("does not send when isAgentWorker() is true (KIMCHI_SUBAGENT=1)", () => {
		savedSubagent = process.env.KIMCHI_SUBAGENT
		process.env.KIMCHI_SUBAGENT = "1"
		applyWriteTodos({ todos: [{ content: "task A", status: "pending" }] })
		const { pi, sendMessage, fireInput } = createInputHarness()
		todosExtension(pi)

		fireInput("interactive")

		expect(sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: TODO_OPEN_REMINDER_TYPE }),
			expect.anything(),
		)
	})
})

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

	it("queues one cleanup nudge when all todos are completed", async () => {
		const harness = createTodosHarness()

		applyWriteTodos({ todos: [{ content: "still active", status: "pending" }] })
		await harness.fire("agent_end", {}, createContext("session", []))
		expect(harness.sendMessage).not.toHaveBeenCalled()

		applyWriteTodos({ todos: [{ id: 1, content: "still active", status: "completed" }] })
		await harness.fire("agent_end", {}, createContext("session", []))
		await harness.fire("agent_end", {}, createContext("session", []))

		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: TODO_CUSTOM_ENTRY_TYPE,
				content: [{ type: "text", text: TODO_CLEANUP_MESSAGE }],
				display: false,
				details: { reason: "completed_todos" },
			},
			{ deliverAs: "nextTurn" },
		)
	})
})
