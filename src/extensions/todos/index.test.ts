import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import todosExtension, { TODO_STEER_MESSAGE } from "./index.js"
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

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: 0,
		},
	} as unknown as SessionEntry
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

	it("steers before the first non-todo tool when no open todos exist", async () => {
		const harness = createTodosHarness()
		const result = (await harness.fire(
			"tool_call",
			toolCall("bash"),
			createContext("session", [
				userEntry(
					"user",
					"Review the todo extension for regressions after recent changes. Inspect prompt guidance and run the narrowest relevant tests.",
				),
			]),
		)) as { block?: boolean; reason?: string }

		expect(result).toEqual({ block: false })
		expect(getTodosForScope()).toEqual([])
		expect(harness.appendEntry).not.toHaveBeenCalled()
		expect(harness.sendMessage).toHaveBeenCalledWith(
			{
				customType: TODO_CUSTOM_ENTRY_TYPE,
				content: [{ type: "text", text: TODO_STEER_MESSAGE }],
				display: false,
				details: { reason: "missing_todos" },
			},
			{ deliverAs: "steer", triggerTurn: false },
		)
	})

	it("steers regardless of the request language", async () => {
		const harness = createTodosHarness()
		const result = (await harness.fire(
			"tool_call",
			toolCall("bash"),
			createContext("session", [
				userEntry("user", "Peržiūrėk todo plėtinį, patikrink įrankių pavadinimus ir paleisk testus."),
			]),
		)) as { block?: boolean; reason?: string }

		expect(result).toEqual({ block: false })
		expect(getTodosForScope()).toEqual([])
		expect(harness.sendMessage).toHaveBeenCalled()
	})

	it("does not spam the missing-todos steer on repeated non-todo tools", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [userEntry("user", "Review the todo extension for regressions.")])

		await harness.fire("tool_call", toolCall("bash"), ctx)
		await harness.fire("tool_call", toolCall("read"), ctx)

		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("resets the missing-todos steer after user input", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [userEntry("user", "Review the todo extension for regressions.")])

		await harness.fire("tool_call", toolCall("bash"), ctx)
		await harness.fire("input", { source: "user", text: "now review the widget" }, ctx)
		await harness.fire("tool_call", toolCall("read"), ctx)

		expect(harness.sendMessage).toHaveBeenCalledTimes(2)
	})

	it("resets the missing-todos steer on session start", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [userEntry("user", "Review the todo extension for regressions.")])

		await harness.fire("tool_call", toolCall("bash"), ctx)
		await harness.fire("session_start", { reason: "new" }, createContext("new-session", []))
		await harness.fire("tool_call", toolCall("read"), ctx)

		expect(harness.sendMessage).toHaveBeenCalledTimes(2)
	})

	it("does not steer for infrastructure tools", async () => {
		const harness = createTodosHarness()
		const result = await harness.fire(
			"tool_call",
			toolCall("set_phase"),
			createContext("session", [userEntry("user", "enter build phase")]),
		)

		expect(result).toEqual({ block: false })
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("allows todo tools to start the list when enforcement is active", async () => {
		const harness = createTodosHarness()
		const result = await harness.fire(
			"tool_call",
			toolCall("add_todo"),
			createContext("session", [userEntry("user", "Review the todo extension for regressions after recent changes.")]),
		)

		expect(result).toEqual({ block: false })
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("allows non-todo tools after an open todo exists", async () => {
		const harness = createTodosHarness()
		applyWriteTodos({ todos: [{ content: "Inspect todo extension", status: "in_progress" }] })

		const result = await harness.fire(
			"tool_call",
			toolCall("bash"),
			createContext("session", [userEntry("user", "Review the todo extension for regressions after recent changes.")]),
		)

		expect(result).toEqual({ block: false })
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("steers for one-off tool lookups too because the tool call is the enforcement point", async () => {
		const harness = createTodosHarness()
		const result = await harness.fire(
			"tool_call",
			toolCall("bash"),
			createContext("session", [userEntry("user", "what time is it?")]),
		)

		expect(result).toEqual({ block: false })
		expect(getTodosForScope()).toEqual([])
		expect(harness.sendMessage).toHaveBeenCalled()
	})
})
