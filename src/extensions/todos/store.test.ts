import { beforeEach, describe, expect, it, vi } from "vitest"
import { runAsAgentWorker } from "../agent-worker-context.js"
import {
	__resetTodoStore,
	applyTodoMutation,
	applyWriteTodos,
	clearTodoStore,
	GLOBAL_TODO_SCOPE,
	getTodoCountsForScope,
	getTodoState,
	getTodosForScope,
	registerActiveTodoScopeProvider,
	resolveTodoScope,
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
		registerActiveTodoScopeProvider(TEST_SESSION_ID, first)
		registerActiveTodoScopeProvider(TEST_SESSION_ID, second)

		applyWriteTodos({ todos: [{ content: "from provider", status: "pending" }] }, TEST_SESSION_ID)
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(1)

		first.mockClear()
		second.mockClear()
		applyWriteTodos({ scope: { kind: "global" }, todos: [{ content: "explicit", status: "pending" }] }, TEST_SESSION_ID)
		expect(first).not.toHaveBeenCalled()
		expect(second).not.toHaveBeenCalled()
	})

	it("treats empty scope placeholders as omitted and lets providers auto-scope", () => {
		const fermentScope = { kind: "ferment-step" as const, phaseId: "phase-1", stepId: "step-1" }
		const unregister = registerActiveTodoScopeProvider(TEST_SESSION_ID, () => fermentScope)
		try {
			// Omission resolves through the provider — baseline behaviour.
			expect(resolveTodoScope(TEST_SESSION_ID)).toEqual(fermentScope)
			// Empty string resolves through providers as if omitted.
			expect(resolveTodoScope(TEST_SESSION_ID, "")).toEqual(fermentScope)
			// GLM-style literal "{}" resolves through providers as if omitted.
			expect(resolveTodoScope(TEST_SESSION_ID, "{}")).toEqual(fermentScope)
			// Empty object resolves through providers as if omitted.
			expect(resolveTodoScope(TEST_SESSION_ID, {})).toEqual(fermentScope)
			// A real scope argument is still honoured verbatim.
			expect(resolveTodoScope(TEST_SESSION_ID, "global")).toEqual(GLOBAL_TODO_SCOPE)
		} finally {
			unregister()
		}
	})

	it("falls back to global in subagent workers regardless of registered providers", async () => {
		const fermentScope = {
			kind: "ferment-step" as const,
			phaseId: "phase-1",
			stepId: "step-1",
		}
		const unregister = registerActiveTodoScopeProvider(TEST_SESSION_ID, () => fermentScope)
		try {
			// Parent (non-worker) still resolves to the provider's scope.
			expect(resolveTodoScope(TEST_SESSION_ID)).toEqual(fermentScope)

			// Inside the AsyncLocalStorage worker context the provider is
			// skipped — scope-less resolution must stay global.
			await runAsAgentWorker(async () => {
				expect(resolveTodoScope(TEST_SESSION_ID)).toEqual(GLOBAL_TODO_SCOPE)
			})
		} finally {
			unregister()
		}
	})

	it("unregisters active scope providers", () => {
		const provider = vi.fn(() => GLOBAL_TODO_SCOPE)
		const unregister = registerActiveTodoScopeProvider(TEST_SESSION_ID, provider)
		unregister()

		applyWriteTodos({ todos: [{ content: "global", status: "pending" }] }, TEST_SESSION_ID)
		expect(provider).not.toHaveBeenCalled()
	})

	it("consults only the querying session's providers, never another session's", () => {
		const stepScope = { kind: "ferment-step" as const, phaseId: "phase-1", stepId: "step-1" }
		// Session A (e.g. a ferment session with one running step) registers a
		// provider under its own session id.
		const unregister = registerActiveTodoScopeProvider("session-a", () => stepScope)
		try {
			// A's own scope-less resolution targets its running step...
			expect(resolveTodoScope("session-a")).toEqual(stepScope)
			// ...while session B — sharing the process — still resolves global:
			// A's ferment-step scope must never leak into B's resolution
			// (regression: it used to suppress B's plan-submission check-in).
			expect(resolveTodoScope("session-b")).toEqual(GLOBAL_TODO_SCOPE)
			// B's scope-less writes stay global, not A's step scope.
			applyWriteTodos({ todos: [{ content: "B task", status: "pending" }] }, "session-b")
			expect(getTodosForScope(stepScope, "session-b")).toHaveLength(0)
			expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b")).toHaveLength(1)
		} finally {
			unregister()
		}
		// Unregistration is scoped too: A's bucket is gone, B never had one.
		expect(resolveTodoScope("session-a")).toEqual(GLOBAL_TODO_SCOPE)
	})

	it("notifies subscribers with write details", () => {
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)

		const details = applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] }, TEST_SESSION_ID)
		expect(listener).toHaveBeenCalledWith(details, TEST_SESSION_ID, undefined)

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

describe("todo store mutations (applyTodoMutation)", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("applies add and mark mutations, preserving every change", () => {
		applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] }, TEST_SESSION_ID)

		const add = applyTodoMutation(GLOBAL_TODO_SCOPE, TEST_SESSION_ID, (todos) => [
			...todos,
			{ content: "bravo", status: "pending" },
		])
		expect(add?.todos.map((todo) => todo.content)).toEqual(["alpha", "bravo"])

		const mark = applyTodoMutation(GLOBAL_TODO_SCOPE, TEST_SESSION_ID, (todos) =>
			todos.map((todo) => (todo.content === "alpha" ? { ...todo, status: "completed" } : todo)),
		)
		expect(mark?.todos.map((todo) => todo.status)).toEqual(["completed", "pending"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID).map((todo) => todo.status)).toEqual([
			"completed",
			"pending",
		])
	})

	it("serializes mutations with replacement and clear writes in call order", () => {
		applyWriteTodos({ todos: [{ content: "one", status: "pending" }] }, TEST_SESSION_ID)

		applyTodoMutation(GLOBAL_TODO_SCOPE, TEST_SESSION_ID, (todos) => [...todos, { content: "two", status: "pending" }])
		applyWriteTodos({ todos: [{ content: "replaced", status: "in_progress" }] }, TEST_SESSION_ID)
		applyTodoMutation(GLOBAL_TODO_SCOPE, TEST_SESSION_ID, (todos) => [
			...todos,
			{ content: "three", status: "pending" },
		])

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID).map((todo) => todo.content)).toEqual([
			"replaced",
			"three",
		])

		applyWriteTodos({ todos: [] }, TEST_SESSION_ID)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toEqual([])
	})

	it("suppresses store notification when the mutator returns undefined", () => {
		applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] }, TEST_SESSION_ID)
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)

		const result = applyTodoMutation(GLOBAL_TODO_SCOPE, TEST_SESSION_ID, () => undefined)

		expect(result).toBeUndefined()
		expect(listener).not.toHaveBeenCalled()
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID).map((todo) => todo.content)).toEqual(["alpha"])
		unsubscribe()
	})

	it("a thrown mutator leaves state unchanged", () => {
		applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] }, TEST_SESSION_ID)
		const before = getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)

		expect(() =>
			applyTodoMutation(GLOBAL_TODO_SCOPE, TEST_SESSION_ID, () => {
				throw new Error("boom")
			}),
		).toThrow("boom")
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toEqual(before)
	})

	it("gives mutators a detached snapshot that cannot tamper with stored items", () => {
		applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] }, TEST_SESSION_ID)

		applyTodoMutation(GLOBAL_TODO_SCOPE, TEST_SESSION_ID, (todos) => {
			;(todos[0] as { content: string }).content = "tampered"
			return undefined
		})

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)[0]?.content).toBe("alpha")
	})

	it("rejects a thenable result without committing or notifying", () => {
		applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] }, TEST_SESSION_ID)
		const before = getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)
		const listener = vi.fn()
		const unsubscribe = subscribeTodoStore(listener)

		expect(() =>
			// The thenable is the point of this test: applyTodoMutation must
			// reject it before committing.
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable
			applyTodoMutation(GLOBAL_TODO_SCOPE, TEST_SESSION_ID, () => ({ then: () => {} }) as never),
		).toThrow(/must be synchronous/)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toEqual(before)
		expect(listener).not.toHaveBeenCalled()
		unsubscribe()
	})

	it("isolates mutations between sessions", () => {
		applyWriteTodos({ todos: [{ content: "for A", status: "pending" }] }, "session-a")

		applyTodoMutation(GLOBAL_TODO_SCOPE, "session-b", (todos) => [...todos, { content: "for B", status: "pending" }])

		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-a").map((todo) => todo.content)).toEqual(["for A"])
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, "session-b").map((todo) => todo.content)).toEqual(["for B"])
	})
})

describe("todo store listener failure isolation", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("a throwing listener does not fail the write, and later listeners still run", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const throwing = vi.fn(() => {
				throw new Error("boom")
			})
			const healthy = vi.fn()
			subscribeTodoStore(throwing)
			subscribeTodoStore(healthy)

			const details = applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] }, TEST_SESSION_ID)

			expect(details.todos.map((todo) => todo.content)).toEqual(["alpha"])
			expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toHaveLength(1)
			expect(healthy).toHaveBeenCalledWith(details, TEST_SESSION_ID, undefined)
			expect(errorSpy).toHaveBeenCalledWith("Todo store listener failed:", expect.any(Error))
		} finally {
			errorSpy.mockRestore()
		}
	})

	it("auto-removes listeners that throw the stale extension-ctx signature", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const stale = vi.fn(() => {
				throw new Error(
					"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
				)
			})
			const healthy = vi.fn()
			subscribeTodoStore(stale)
			subscribeTodoStore(healthy)

			applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] }, TEST_SESSION_ID)
			applyWriteTodos({ todos: [{ content: "bravo", status: "pending" }] }, TEST_SESSION_ID)

			// The stale listener detonated once, then was removed; the healthy
			// listener keeps receiving every write.
			expect(stale).toHaveBeenCalledTimes(1)
			expect(healthy).toHaveBeenCalledTimes(2)
		} finally {
			errorSpy.mockRestore()
		}
	})

	it("keeps listeners that throw generic errors subscribed", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			const throwing = vi.fn(() => {
				throw new Error("transient boom")
			})
			subscribeTodoStore(throwing)

			applyWriteTodos({ todos: [{ content: "alpha", status: "pending" }] }, TEST_SESSION_ID)
			applyWriteTodos({ todos: [{ content: "bravo", status: "pending" }] }, TEST_SESSION_ID)

			expect(throwing).toHaveBeenCalledTimes(2)
			expect(errorSpy).toHaveBeenCalledTimes(2)
		} finally {
			errorSpy.mockRestore()
		}
	})
})
