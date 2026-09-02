import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetTodoStore, GLOBAL_TODO_SCOPE, getTodosForScope } from "./store.js"
import { CREATE_TODOS_TOOL_NAME, registerTodosTool, TODO_TOOL_NAMES, UPDATE_TODOS_TOOL_NAME } from "./tool.js"

function fakeCtx(sessionId: string): ExtensionContext {
	return {
		hasUI: false,
		cwd: "/test",
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext
}

function registeredTools() {
	const registerTool = vi.fn()
	registerTodosTool({ registerTool } as never)
	return Object.fromEntries(registerTool.mock.calls.map(([tool]) => [tool.name, tool]))
}

describe("todo tools", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("registers todo tool aliases", () => {
		const registerTool = vi.fn()
		registerTodosTool({ registerTool } as never)

		expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([...TODO_TOOL_NAMES])
		expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
			CREATE_TODOS_TOOL_NAME,
			UPDATE_TODOS_TOOL_NAME,
			"add_todo",
			"mark_todo",
			"clear_todos",
		])
	})

	it("returns a structured error when reducer validation fails", async () => {
		const tool = registeredTools()[UPDATE_TODOS_TOOL_NAME]
		const result = await tool.execute(
			"call-1",
			{
				todos: [
					{ id: 1, content: "one", status: "pending" },
					{ id: 1, content: "two", status: "pending" },
				],
			},
			undefined,
			undefined,
			fakeCtx("session"),
		)

		expect(result).toEqual({
			content: [{ type: "text", text: "Failed to write todos: Duplicate todo id '1'" }],
			details: null,
		})
	})

	it("describes update_todos as whole-list replacement for plan changes only", () => {
		const tools = registeredTools()
		const tool = tools[UPDATE_TODOS_TOOL_NAME]

		expect(tool.description).toContain("Replace the entire todo list")
		expect(tool.description).toContain("mark_todo instead")
		expect(tool.description).toContain("add_todo instead")
		// Guards against regressing to the "batch progress updates" wording that
		// invited whole-list rewrites for routine status changes.
		expect(tool.promptSnippet).toBe("Replace the whole todo list when the plan changes")
	})

	it("describes add_todo as the preferred single-item append path", () => {
		const tools = registeredTools()
		const tool = tools.add_todo

		expect(tool.promptSnippet).toBe("Add one todo — prefer over rewriting the list")
		expect(tool.description).toContain("Prefer this over rewriting the whole list")
	})

	it("describes and executes create_todos as the initial planning path", async () => {
		const tools = registeredTools()
		const tool = tools[CREATE_TODOS_TOOL_NAME]

		expect(tool.description).toContain("Create the initial todo list")
		expect(tool.description).toContain("before starting multi-step tasks")
		expect(tool.promptSnippet).toBe("Create the initial todo list before multi-step work")

		const result = await tool.execute(
			"create-1",
			{ todos: [{ content: "inspect trace", status: "in_progress" }] },
			undefined,
			undefined,
			fakeCtx("session"),
		)

		expect(result.content).toEqual([{ type: "text", text: "Updated 1 todos in global." }])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["inspect trace"])
	})

	it("marking an unchanged status is a no-op with a corrective notice", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")

		await tools.add_todo.execute("add-1", { content: "alpha", status: "pending" }, undefined, undefined, ctx)
		const before = getTodosForScope(GLOBAL_TODO_SCOPE, "session")

		const result = await tools.mark_todo.execute("mark-1", { id: 1, status: "pending" }, undefined, undefined, ctx)

		expect(result.content).toEqual([
			{
				type: "text",
				text: "Todo #1 is already 'pending' — no change made. Don't re-mark todos whose status hasn't changed.",
			},
		])
		expect(result.details).toBeNull()
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual(before)
	})

	it("marking the same status with a new note still writes", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")

		await tools.add_todo.execute("add-1", { content: "alpha" }, undefined, undefined, ctx)
		const result = await tools.mark_todo.execute(
			"mark-1",
			{ id: 1, status: "pending", note: "blocked on fixture" },
			undefined,
			undefined,
			ctx,
		)

		expect(result.content).toEqual([{ type: "text", text: "Marked todo #1 pending in global." }])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").find((todo) => todo.id === 1)?.note).toBe(
			"blocked on fixture",
		)
	})

	it("marking an unknown id returns a soft steer, not an error", async () => {
		const tools = registeredTools()
		const result = await tools.mark_todo.execute(
			"mark-1",
			{ id: 42, status: "completed" },
			undefined,
			undefined,
			fakeCtx("session"),
		)

		expect(result.details).toBeNull()
		expect(result.content[0].text).toBe(
			"Todo #42 doesn't exist in global — the list may have been replaced. Check the current ids in the todo list before marking again.",
		)
		expect(result.content[0].text).not.toContain("Failed")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual([])
	})

	it("adds, marks, and clears todos", async () => {
		const tools = registeredTools()
		const ctx = fakeCtx("session")

		await tools.add_todo.execute("add-1", { content: "alpha" }, undefined, undefined, ctx)
		await tools.add_todo.execute("add-2", { content: "bravo" }, undefined, undefined, ctx)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").map((todo) => todo.content)).toEqual(["alpha", "bravo"])

		await tools.mark_todo.execute("mark-1", { id: 1, status: "completed" }, undefined, undefined, ctx)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session").find((todo) => todo.id === 1)?.status).toBe("completed")

		const clearResult = await tools.clear_todos.execute("clear-1", {}, undefined, undefined, ctx)
		expect(clearResult.details.todos).toEqual([])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session")).toEqual([])
	})

	it("writes through to the session id reported by ctx.sessionManager", async () => {
		const tools = registeredTools()
		const ctxA = fakeCtx("session-a")
		const ctxB = fakeCtx("session-b")

		await tools.update_todos.execute(
			"u-a",
			{ todos: [{ content: "alpha", status: "in_progress" }] },
			undefined,
			undefined,
			ctxA,
		)
		await tools.update_todos.execute(
			"u-b",
			{ todos: [{ content: "beta", status: "pending" }] },
			undefined,
			undefined,
			ctxB,
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["alpha"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b").map((todo) => todo.content)).toEqual(["beta"])
	})
})
