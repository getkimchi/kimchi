import { beforeEach, describe, expect, it, vi } from "vitest"
import { __resetTodoStore, getTodosForScope } from "./store.js"
import { TODO_TOOL_NAMES, UPDATE_TODOS_TOOL_NAME, registerTodosTool } from "./tool.js"

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
	})

	it("returns a structured error when reducer validation fails", async () => {
		const tool = registeredTools()[UPDATE_TODOS_TOOL_NAME]
		const result = await tool.execute("call-1", {
			todos: [
				{ id: 1, content: "one", status: "pending" },
				{ id: 1, content: "two", status: "pending" },
			],
		})

		expect(result).toEqual({
			content: [{ type: "text", text: "Failed to write todos: Duplicate todo id '1'" }],
			details: null,
		})
	})

	it("describes update_todos as an update path", () => {
		const tools = registeredTools()
		const tool = tools[UPDATE_TODOS_TOOL_NAME]

		expect(tool.description).toContain("Update todo progress")
		expect(tool.description).toContain("meaningful progress")
	})

	it("adds, marks, and clears todos", async () => {
		const tools = registeredTools()

		await tools.add_todo.execute("add-1", { content: "alpha" })
		await tools.add_todo.execute("add-2", { content: "bravo" })

		expect(getTodosForScope().map((todo) => todo.content)).toEqual(["alpha", "bravo"])

		await tools.mark_todo.execute("mark-1", { id: 1, status: "completed" })
		expect(getTodosForScope().find((todo) => todo.id === 1)?.status).toBe("completed")

		const clearResult = await tools.clear_todos.execute("clear-1", {})
		expect(clearResult.details.todos).toEqual([])
		expect(getTodosForScope()).toEqual([])
	})
})
