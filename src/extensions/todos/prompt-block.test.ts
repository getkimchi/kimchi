import { beforeEach, describe, expect, it } from "vitest"
import { __test_renderTodoPromptBlock, appendTodoPromptBlockIfMissing } from "./prompt-block.js"
import { __resetTodoStore, applyWriteTodos } from "./store.js"

describe("todo prompt block", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("renders guidance without a current list", () => {
		const block = __test_renderTodoPromptBlock()
		expect(block).toContain("## Todos")
		expect(block).toContain("For any non-trivial task, maintain a todo list.")
		expect(block).toContain("code changes, debugging, reviews, investigations")
		expect(block).toContain("Skip todos only for a single straightforward answer")
		expect(block).toContain("different from leaving TODO comments/placeholders in code")
		expect(block).toContain("Use add_todo for one missing item")
		expect(block).toContain("mark_todo for one status change")
		expect(block).toContain("clear_todos only when the work is done or obsolete")
		expect(block).toContain("before your final response")
		expect(block).not.toContain("Current global todos:")
	})

	it("keeps guidance stable when todos exist", () => {
		applyWriteTodos({
			todos: [
				{ content: "alpha", status: "in_progress" },
				{ content: "bravo", status: "pending" },
			],
		})

		expect(__test_renderTodoPromptBlock()).not.toContain("Current global todos:")
		expect(__test_renderTodoPromptBlock()).not.toContain("alpha")
		expect(__test_renderTodoPromptBlock()).not.toContain("bravo")
	})

	it("appends guidance when the assembled system prompt missed the todo block", () => {
		const prompt = appendTodoPromptBlockIfMissing("## Tools\n- read")

		expect(prompt).toContain("## Tools")
		expect(prompt).toContain("## Todos")
		expect(appendTodoPromptBlockIfMissing(prompt ?? "")).toBeUndefined()
	})
})
