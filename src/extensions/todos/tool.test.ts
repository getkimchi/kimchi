import { describe, expect, it, vi } from "vitest"
import { registerTodosTool } from "./tool.js"

describe("write_todos tool", () => {
	it("returns a structured error when reducer validation fails", async () => {
		const registerTool = vi.fn()
		registerTodosTool({ registerTool } as never)

		const tool = registerTool.mock.calls[0][0]
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
})
