import type { ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import todosExtension from "./index.js"
import { __resetTodoStore, applyWriteTodos, GLOBAL_TODO_SCOPE, getTodosForScope, hasEverHadTodos } from "./store.js"
import { TODO_TOOL_NAMES, UPDATE_TODOS_TOOL_NAME } from "./tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type TodoStatus } from "./types.js"

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme

function createTodosHarness(activeTools: string[] = [...TODO_TOOL_NAMES]) {
	const handlers = new Map<string, ExtensionHandler[]>()
	const pi = {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		getActiveTools: vi.fn(() => activeTools),
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
		getActiveTools: pi.getActiveTools,
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
		applyWriteTodos({ todos: [{ content: "stale previous session", status: "pending" }] }, "previous-session")

		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("resumed-session", [
				writeTodosEntry("a", "superseded resumed todo"),
				writeTodosEntry("b", "current resumed todo", "in_progress"),
			]),
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "resumed-session").map((todo) => todo.content)).toEqual([
			"current resumed todo",
		])
	})

	it("clears stale todos when the replacement session has no todo history", async () => {
		const harness = createTodosHarness()
		applyWriteTodos({ todos: [{ content: "stale previous session", status: "pending" }] }, "previous-session")

		await harness.fire("session_start", { reason: "fork" }, createContext("forked-session", []))

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "forked-session")).toEqual([])
	})

	it("replays todos when the active session tree branch changes", async () => {
		const harness = createTodosHarness()
		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("session", [writeTodosEntry("a", "root todo")]),
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["root todo"])

		await harness.fire(
			"session_tree",
			{ oldLeafId: "a", newLeafId: "b" },
			createContext("session", [writeTodosEntry("b", "branch todo", "in_progress")]),
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["branch todo"])
	})

	it("restores slash-command todo edits from custom entries", async () => {
		const harness = createTodosHarness()

		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("session", [customTodosEntry("c", "command todo")]),
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["command todo"])
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

			expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual([`${toolName} todo`])
			expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")[0]?.status).toBe("completed")
		}
	})

	it("restores todos from legacy write_todos tool results", async () => {
		const harness = createTodosHarness()

		await harness.fire(
			"session_start",
			{ reason: "resume" },
			createContext("session", [writeTodosEntry("legacy", "legacy todo", "in_progress", "write_todos")]),
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["legacy todo"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")[0]?.status).toBe("in_progress")
	})

	it("does not inject hidden todo steers for non-todo tool calls", async () => {
		const harness = createTodosHarness()
		const result = await harness.fire("tool_call", toolCall("bash"), createContext("session", []))

		expect(result).toBeUndefined()
		expect(harness.appendEntry).not.toHaveBeenCalled()
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})
})

describe("passive staleness counter", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("injects todo state into the context on every LLM call", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "check work", status: "in_progress" }] }, "session")

		const result = (await harness.fire("context", { messages: [] }, ctx)) as
			| { messages: Array<{ role?: string; content?: string }> }
			| undefined
		expect(result).toBeDefined()
		expect(result?.messages).toHaveLength(1)
		expect(result?.messages[0]?.content).toMatch(/^<system-reminder>\n/)
		expect(result?.messages[0]?.content).toMatch(/\n<\/system-reminder>$/)
		expect(result?.messages[0]?.content).toContain("## Current Todos")
		expect(result?.messages[0]?.content).toContain("check work")
	})

	it("does not send reconciliation follow-ups after terminal turns", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "still active", status: "in_progress" }] }, "session")
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)

		// No reconciliation follow-up should be sent — the old forced-turn
		// mechanism has been removed.
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("does not send reconciliation follow-ups even after multiple terminal stops", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "still active", status: "in_progress" }] }, "session")
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)
		await harness.fire("turn_end", terminalTurnWithText(), ctx)

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("does not reconcile immediately after only writing todos", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		applyWriteTodos({ todos: [{ content: "new plan", status: "pending" }] }, "session")
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

		applyWriteTodos({ todos: [{ content: "visible active todo", status: "in_progress" }] }, "session")
		const component = setWidget.mock.calls[0][1]
		const instance = component({ requestRender: vi.fn() }, theme)
		instance.dispose()

		await harness.fire("turn_end", terminalTurn(), ctx)

		expect(setWidget).toHaveBeenCalledTimes(2)
		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("does not reconcile on non-terminal turns", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)
		applyWriteTodos({ todos: [{ content: "still active", status: "in_progress" }] }, "session")
		await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)

		await harness.fire("turn_end", { message: { role: "assistant", stopReason: "aborted" }, toolResults: [] }, ctx)
		await harness.fire("turn_end", { message: { role: "assistant" }, toolResults: [{}] }, ctx)
		await harness.fire("turn_end", terminalTurn(), createContext("session", [], { hasPendingMessages: true }))

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("isolates todos between concurrent sessions", async () => {
		const harness = createTodosHarness()
		const ctxA = createContext("session-a", [writeTodosEntry("a1", "alpha for A", "in_progress")])
		const ctxB = createContext("session-b", [])

		await harness.fire("session_start", { reason: "new" }, ctxA)
		await harness.fire("session_start", { reason: "new" }, ctxB)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["alpha for A"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b")).toEqual([])

		// Writes targeted at session-b must not bleed into session-a.
		applyWriteTodos({ todos: [{ content: "beta for B", status: "pending" }] }, "session-b")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["alpha for A"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b").map((todo) => todo.content)).toEqual(["beta for B"])
	})
})

describe("early todo nudge", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("fires when the model does multi-step work without ever creating a todo list", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		// Ten successful non-todo tool calls, no list ever created. The one-shot
		// nudge threshold is 5, so it should have fired.
		for (let i = 0; i < 10; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
		expect(vi.mocked(harness.sendMessage).mock.calls[0]?.[0]).toMatchObject({
			details: { reason: "early_nudge" },
		})
	})

	it("does not fire when the session already has a todo list", async () => {
		const harness = createTodosHarness()
		// Resumed session: the branch already contains a todo list.
		const ctx = createContext("session", [writeTodosEntry("a", "restored work", "in_progress")])
		await harness.fire("session_start", { reason: "resume" }, ctx)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toHaveLength(1)

		for (let i = 0; i < 10; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})

	it("fires only once even if the model continues without creating a list", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		for (let i = 0; i < 20; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		expect(harness.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("delivers the nudge as a steer, never a follow-up", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		for (let i = 0; i < 10; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		expect(vi.mocked(harness.sendMessage).mock.calls[0]?.[1]).toEqual({ deliverAs: "steer" })
	})

	it("does not fire when the model creates a todo list before the threshold", async () => {
		const harness = createTodosHarness()
		const ctx = createContext("session", [])
		await harness.fire("session_start", { reason: "new" }, ctx)

		// Three tool calls, then create a todo list (below threshold of 5).
		for (let i = 0; i < 3; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}
		applyWriteTodos({ todos: [{ content: "work", status: "in_progress" }] }, "session")
		expect(hasEverHadTodos("session")).toBe(true)

		// More tool calls — nudge should not fire because the session has had todos.
		for (let i = 0; i < 10; i++) {
			await harness.fire("tool_execution_end", { toolName: "bash", isError: false }, ctx)
		}

		expect(harness.sendMessage).not.toHaveBeenCalled()
	})
})
