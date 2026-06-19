import { describe, expect, it } from "vitest"
import { createEmptyTodosSliceState, reduceReplaceList, reduceTodos } from "./reducer.js"
import { getTodoScopeKey } from "./scope.js"
import type { WriteTodosParams } from "./types.js"

const GLOBAL_SCOPE = { kind: "global" } as const

describe("reduceReplaceList", () => {
	it("rejects invalid action", () => {
		const badParams = {
			action: "bad",
			scope: GLOBAL_SCOPE,
			todos: [],
		} as unknown as WriteTodosParams
		expect(() => reduceReplaceList(createEmptyTodosSliceState(), badParams)).toThrowError(/Unsupported todo action/)
	})

	it("drops empty todos and defaults missing statuses to pending", () => {
		const result = reduceReplaceList(createEmptyTodosSliceState(), {
			action: "replace-list",
			scope: GLOBAL_SCOPE,
			todos: [{ content: "  " }, { content: " keep  me " }] as unknown as WriteTodosParams["todos"],
		})

		expect(result.details.todos).toEqual([{ id: 1, content: "keep me", status: "pending" }])
	})

	it("rejects invalid statuses", () => {
		expect(() =>
			reduceReplaceList(createEmptyTodosSliceState(), {
				action: "replace-list",
				scope: GLOBAL_SCOPE,
				todos: [{ content: "keep me", status: "not-real" }] as unknown as WriteTodosParams["todos"],
			}),
		).toThrowError(/Invalid todo status/)
	})

	it("replaces list and preserves supplied IDs while assigning missing IDs deterministically", () => {
		let state = createEmptyTodosSliceState()
		state = reduceReplaceList(state, {
			action: "replace-list",
			scope: GLOBAL_SCOPE,
			todos: [
				{ content: "alpha", status: "pending" },
				{ id: 3, content: "bravo", status: "completed" },
				{ content: "charlie", status: "pending" },
			],
		}).state
		const scopeKey = getTodoScopeKey(GLOBAL_SCOPE)
		expect(state.byScope[scopeKey].todos).toEqual([
			{ id: 1, content: "alpha", status: "pending" },
			{ id: 3, content: "bravo", status: "completed" },
			{ id: 4, content: "charlie", status: "pending" },
		])

		const secondState = reduceReplaceList(state, {
			action: "replace-list",
			scope: GLOBAL_SCOPE,
			todos: [
				{ id: 3, content: "bravo updated", status: "completed" },
				{ content: "delta", status: "pending" },
			],
		}).state
		expect(secondState.byScope[scopeKey].todos).toEqual([
			{ id: 3, content: "bravo updated", status: "completed" },
			{ id: 5, content: "delta", status: "pending" },
		])
	})

	it("keeps todos in creation order when statuses change", () => {
		const state = reduceReplaceList(createEmptyTodosSliceState(), {
			action: "replace-list",
			scope: GLOBAL_SCOPE,
			todos: [
				{ content: "done", status: "completed" },
				{ content: "blocked", status: "blocked" },
				{ content: "pending", status: "pending" },
				{ content: "active", status: "in_progress" },
			],
		}).state

		expect(state.byScope[getTodoScopeKey(GLOBAL_SCOPE)].todos.map((todo) => todo.content)).toEqual([
			"done",
			"blocked",
			"pending",
			"active",
		])
	})

	it("rejects invalid and duplicate IDs", () => {
		const state = createEmptyTodosSliceState()
		expect(() =>
			reduceReplaceList(state, {
				scope: GLOBAL_SCOPE,
				todos: [{ id: 0, content: "bad", status: "pending" }],
			}),
		).toThrowError(/positive integer/)
		expect(() =>
			reduceReplaceList(state, {
				scope: GLOBAL_SCOPE,
				todos: [
					{ id: 1, content: "one", status: "pending" },
					{ id: 1, content: "two", status: "pending" },
				],
			}),
		).toThrowError(/Duplicate todo id/)
	})

	it("clears scope when todos array is empty", () => {
		let state = createEmptyTodosSliceState()
		state = reduceReplaceList(state, {
			scope: GLOBAL_SCOPE,
			todos: [{ content: "alpha", status: "pending" }],
		}).state
		const scopeKey = getTodoScopeKey(GLOBAL_SCOPE)
		expect(state.byScope[scopeKey]).toBeDefined()

		const cleared = reduceReplaceList(state, { scope: GLOBAL_SCOPE, todos: [] }).state
		expect(Object.hasOwn(cleared.byScope, scopeKey)).toBe(false)
	})

	it("serializes details with schemaVersion, scope, todos, updatedAt", () => {
		const { details } = reduceReplaceList(createEmptyTodosSliceState(), {
			scope: GLOBAL_SCOPE,
			todos: [{ content: "one", status: "pending" }],
		})

		expect(details.schemaVersion).toBe(1)
		expect(details.scope).toEqual({ kind: "global" })
		expect(details.todos).toEqual([{ id: 1, content: "one", status: "pending" }])
		expect(Date.parse(details.updatedAt)).not.toBeNaN()
	})

	it("aliases the generic reducer entry", () => {
		const result = reduceTodos(createEmptyTodosSliceState(), {
			scope: GLOBAL_SCOPE,
			todos: [{ content: "alpha", status: "completed" }],
		})
		expect(result.details.scope).toEqual(GLOBAL_SCOPE)
	})
})
