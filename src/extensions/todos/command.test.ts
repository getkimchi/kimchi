import { beforeEach, describe, expect, it } from "vitest"
import { __test_applyTodoAction, __test_parseTodoArgs } from "./command.js"
import { __resetTodoStore, applyWriteTodos, getTodosForScope } from "./store.js"

describe("/todos command helpers", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("parses supported subcommands", () => {
		expect(__test_parseTodoArgs("")).toEqual({ action: "open", text: "", index: null })
		expect(__test_parseTodoArgs("add ship it")).toEqual({ action: "add", text: "ship it", index: null })
		expect(__test_parseTodoArgs("done 2")).toEqual({ action: "done", text: "", index: 1 })
		expect(__test_parseTodoArgs("start 1")).toEqual({ action: "start", text: "", index: 0 })
		expect(__test_parseTodoArgs("block 3")).toEqual({ action: "block", text: "", index: 2 })
		expect(__test_parseTodoArgs("remove 4")).toEqual({ action: "delete", text: "", index: 3 })
	})

	it("adds and updates todos through store writes", () => {
		expect(__test_applyTodoAction({ action: "add", text: " first task ", index: null })).toEqual({
			message: "Added todo: first task",
			level: "info",
		})
		expect(getTodosForScope()).toEqual([{ id: 1, content: "first task", status: "pending" }])

		__test_applyTodoAction({ action: "start", text: "", index: 0 })
		expect(getTodosForScope()[0]).toMatchObject({ status: "in_progress" })

		__test_applyTodoAction({ action: "block", text: "", index: 0 })
		expect(getTodosForScope()[0]).toMatchObject({ status: "blocked" })

		__test_applyTodoAction({ action: "done", text: "", index: 0 })
		expect(getTodosForScope()[0]).toMatchObject({ status: "completed" })
	})

	it("removes and clears todos", () => {
		applyWriteTodos({
			todos: [
				{ content: "one", status: "pending" },
				{ content: "two", status: "pending" },
			],
		})

		__test_applyTodoAction({ action: "delete", text: "", index: 0 })
		expect(getTodosForScope().map((todo) => todo.content)).toEqual(["two"])

		__test_applyTodoAction({ action: "clear", text: "", index: null })
		expect(getTodosForScope()).toEqual([])
	})
})
