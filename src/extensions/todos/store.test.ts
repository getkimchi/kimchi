import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	GLOBAL_TODO_SCOPE,
	__resetTodoStore,
	applyWriteTodos,
	clearTodoStore,
	getTodoCountsForScope,
	getTodoState,
	getTodosForScope,
	registerActiveTodoScopeProvider,
	subscribeTodoStore,
} from "./store.js"

describe("todo store", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("replaces, reads, counts, and clears global todos", () => {
		applyWriteTodos({
			todos: [
				{ content: "alpha", status: "in_progress" },
				{ content: "bravo", status: "blocked" },
				{ content: "charlie", status: "completed" },
			],
		})

		expect(getTodosForScope(GLOBAL_TODO_SCOPE).map((todo) => todo.content)).toEqual(["alpha", "bravo", "charlie"])
		expect(getTodoCountsForScope(GLOBAL_TODO_SCOPE)).toEqual({
			total: 3,
			completed: 1,
			pending: 0,
			blocked: 1,
			inProgress: 1,
		})

		clearTodoStore()
		expect(getTodoState()).toEqual({ byScope: {} })
	})

	it("uses providers only when scope is omitted", () => {
		const first = vi.fn(() => undefined)
		const second = vi.fn(() => GLOBAL_TODO_SCOPE)
		registerActiveTodoScopeProvider(first)
		registerActiveTodoScopeProvider(second)

		applyWriteTodos({ todos: [{ content: "from provider", status: "pending" }] })
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(1)

		first.mockClear()
		second.mockClear()
		applyWriteTodos({ scope: { kind: "global" }, todos: [{ content: "explicit", status: "pending" }] })
		expect(first).not.toHaveBeenCalled()
		expect(second).not.toHaveBeenCalled()
	})

	it("unregisters active scope providers", () => {
		const provider = vi.fn(() => GLOBAL_TODO_SCOPE)
		const unregister = registerActiveTodoScopeProvider(provider)
		unregister()

		applyWriteTodos({ todos: [{ content: "global", status: "pending" }] })
		expect(provider).not.toHaveBeenCalled()
	})

	it("notifies subscribers with write details", () => {
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)

		const details = applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] })
		expect(listener).toHaveBeenCalledWith(details)

		unsubscribe()
		applyWriteTodos({ todos: [{ content: "bravo", status: "pending" }] })
		expect(listener).toHaveBeenCalledTimes(1)
	})
})
