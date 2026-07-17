import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	__resetTodoStore,
	applyWriteTodos,
	clearTodoStore,
	GLOBAL_TODO_SCOPE,
	getTodoCountsForScope,
	getTodoState,
	getTodosForScope,
	registerActiveTodoScopeProvider,
	restoreTodoStoreFromDetails,
	subscribeTodoStore,
} from "./store.js"
import type { WriteTodosDetails } from "./types.js"

const TEST_SESSION_ID = "test-session"

describe("todo store", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("replaces, reads, counts, and clears global todos", () => {
		applyWriteTodos(
			{
				todos: [
					{ content: "alpha", status: "in_progress" },
					{ content: "bravo", status: "blocked" },
					{ content: "charlie", status: "completed" },
				],
			},
			TEST_SESSION_ID,
		)

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID).map((todo) => todo.content)).toEqual([
			"alpha",
			"bravo",
			"charlie",
		])
		expect(getTodoCountsForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toEqual({
			total: 3,
			completed: 1,
			pending: 0,
			blocked: 1,
			inProgress: 1,
		})

		clearTodoStore(TEST_SESSION_ID)
		expect(getTodoState(TEST_SESSION_ID)).toEqual({ byScope: {} })
	})

	it("isolates todos between different session ids", () => {
		applyWriteTodos({ todos: [{ content: "for session A", status: "in_progress" }] }, "session-a")
		applyWriteTodos({ todos: [{ content: "for session B", status: "pending" }] }, "session-b")

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["for session A"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b").map((todo) => todo.content)).toEqual(["for session B"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toEqual([])
	})

	it("restoreTodoStoreFromDetails targets the given session id only", () => {
		const detailsA: WriteTodosDetails = {
			schemaVersion: 1,
			scope: { kind: "global" },
			todos: [{ id: 1, content: "restored A", status: "in_progress" }],
			updatedAt: "2026-01-01T00:00:00.000Z",
		}
		const detailsB: WriteTodosDetails = {
			schemaVersion: 1,
			scope: { kind: "global" },
			todos: [{ id: 1, content: "restored B", status: "completed" }],
			updatedAt: "2026-01-01T00:00:00.000Z",
		}

		restoreTodoStoreFromDetails([detailsA], "session-a")
		restoreTodoStoreFromDetails([detailsB], "session-b")

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["restored A"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b").map((todo) => todo.content)).toEqual(["restored B"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toEqual([])
	})

	it("clearTodoStore(sessionId) clears only that session", () => {
		applyWriteTodos({ todos: [{ content: "keep", status: "pending" }] }, "session-a")
		applyWriteTodos({ todos: [{ content: "drop", status: "pending" }] }, "session-b")

		clearTodoStore("session-b")

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["keep"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b")).toEqual([])
	})

	it("__resetTodoStore clears every session bucket", () => {
		applyWriteTodos({ todos: [{ content: "a", status: "pending" }] }, "session-a")
		applyWriteTodos({ todos: [{ content: "b", status: "pending" }] }, "session-b")

		__resetTodoStore()

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a")).toEqual([])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b")).toEqual([])
	})

	it("routes scope-less writes to the supplied session", () => {
		applyWriteTodos({ todos: [{ content: "explicit session", status: "pending" }] }, TEST_SESSION_ID)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID).map((todo) => todo.content)).toEqual([
			"explicit session",
		])
	})

	it("uses providers only when scope is omitted", () => {
		const first = vi.fn(() => undefined)
		const second = vi.fn(() => GLOBAL_TODO_SCOPE)
		registerActiveTodoScopeProvider(first)
		registerActiveTodoScopeProvider(second)

		applyWriteTodos({ todos: [{ content: "from provider", status: "pending" }] }, TEST_SESSION_ID)
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(1)

		first.mockClear()
		second.mockClear()
		applyWriteTodos({ scope: { kind: "global" }, todos: [{ content: "explicit", status: "pending" }] }, TEST_SESSION_ID)
		expect(first).not.toHaveBeenCalled()
		expect(second).not.toHaveBeenCalled()
	})

	it("unregisters active scope providers", () => {
		const provider = vi.fn(() => GLOBAL_TODO_SCOPE)
		const unregister = registerActiveTodoScopeProvider(provider)
		unregister()

		applyWriteTodos({ todos: [{ content: "global", status: "pending" }] }, TEST_SESSION_ID)
		expect(provider).not.toHaveBeenCalled()
	})

	it("notifies subscribers with write details", () => {
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)

		const details = applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] }, TEST_SESSION_ID)
		expect(listener).toHaveBeenCalledWith(details, TEST_SESSION_ID)

		unsubscribe()
		applyWriteTodos({ todos: [{ content: "bravo", status: "pending" }] }, TEST_SESSION_ID)
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it("notifies subscribers with the writing session id, not the subscriber's session", () => {
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)

		applyWriteTodos({ todos: [{ content: "from A", status: "pending" }] }, "session-a")
		applyWriteTodos({ todos: [{ content: "from B", status: "pending" }] }, "session-b")

		expect(listener).toHaveBeenCalledTimes(2)
		expect(listener.mock.calls[0]?.[1]).toBe("session-a")
		expect(listener.mock.calls[1]?.[1]).toBe("session-b")

		unsubscribe()
	})
})
