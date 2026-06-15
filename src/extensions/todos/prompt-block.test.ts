import { beforeEach, describe, expect, it } from "vitest"
import { __test_renderTodoPromptBlock } from "./prompt-block.js"
import { __resetTodoStore, applyWriteTodos } from "./store.js"

describe("todo prompt block", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("renders guidance without a current list", () => {
		const block = __test_renderTodoPromptBlock()
		expect(block).toContain("## Todos")
		expect(block).toContain("Do not use write_todos for a single straightforward or purely conversational task.")
		expect(block).not.toContain("Current global todos:")
	})

	it("appends current global todos", () => {
		applyWriteTodos({
			todos: [
				{ content: "alpha", status: "in_progress" },
				{ content: "bravo", status: "pending" },
			],
		})

		expect(__test_renderTodoPromptBlock()).toContain(
			"Current global todos:\n- #1 [in_progress] alpha\n- #2 [pending] bravo",
		)
	})
})
