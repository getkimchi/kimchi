import { describe, expect, it } from "vitest"
import { createEmptyTodosSliceState, reduceReplaceList, reduceTodos } from "./reducer.js"
import { getTodoScopeKey, normalizeTodoScope, parseTodoScopeKey } from "./scope.js"
import type { WriteTodosParams } from "./types.js"

const GLOBAL_SCOPE = { kind: "global" } as const
const STEP_SCOPE = { kind: "ferment_step", stepId: "step-1", phaseId: "phase-1", fermentId: "f-1" } as const
const AGENT_SCOPE = { kind: "agent", agentId: "agent-1" } as const

describe("todo scope helpers", () => {
	it("normalizes global scope from string and object", () => {
		expect(normalizeTodoScope("global")).toEqual({ kind: "global" })
		expect(normalizeTodoScope({ kind: "global" })).toEqual({ kind: "global" })
	})

	it("normalizes ferment_step scope", () => {
		expect(
			normalizeTodoScope({ kind: "ferment_step", stepId: "step-1", phaseId: "phase-1", fermentId: "f-1" }),
		).toEqual(STEP_SCOPE)
		expect(normalizeTodoScope({ kind: "step", stepId: "step-1", phaseId: "phase-1", fermentId: "f-1" })).toEqual(
			STEP_SCOPE,
		)
	})

	it("builds deterministic scope keys", () => {
		expect(getTodoScopeKey(GLOBAL_SCOPE)).toBe("global")
		expect(getTodoScopeKey(AGENT_SCOPE)).toBe("agent:agent-1")
		expect(parseTodoScopeKey("agent:agent-1")).toEqual(AGENT_SCOPE)
		expect(getTodoScopeKey(STEP_SCOPE)).toBe("ferment_step:f-1:phase-1:step-1")
		expect(parseTodoScopeKey("ferment_step:f-1:phase-1:step-1")).toEqual(STEP_SCOPE)
	})

	it("normalizes private agent scopes", () => {
		expect(normalizeTodoScope({ kind: "agent", agent_id: "agent-1" })).toEqual(AGENT_SCOPE)
		expect(normalizeTodoScope({ kind: "subagent", agentId: "agent-1" })).toEqual(AGENT_SCOPE)
	})

	it("rejects invalid scope shapes", () => {
		expect(() => normalizeTodoScope({ kind: "bad" })).toThrowError(/Invalid todo scope type/)
		expect(() => normalizeTodoScope({ kind: "ferment_step" })).toThrowError(/missing fermentId/)
		expect(() => parseTodoScopeKey("bad:key")).toThrowError(/Invalid todo scope key/)
	})
})

describe("reduceReplaceList", () => {
	it("rejects invalid action", () => {
		const badParams = {
			action: "bad",
			scope: GLOBAL_SCOPE,
			todos: [],
		} as unknown as WriteTodosParams
		expect(() => reduceReplaceList(createEmptyTodosSliceState(), badParams)).toThrowError(/Unsupported todo action/)
	})

	it("rejects empty content and empty status", () => {
		const state = createEmptyTodosSliceState()
		expect(() =>
			reduceReplaceList(state, {
				action: "replace-list",
				scope: GLOBAL_SCOPE,
				todos: [{ content: "", status: "pending" }],
			}),
		).toThrowError(/Todo content must be a non-empty string/)
		expect(() =>
			reduceReplaceList(state, {
				action: "replace-list",
				scope: GLOBAL_SCOPE,
				todos: [{ content: "x", status: "" }] as unknown as WriteTodosParams["todos"],
			}),
		).toThrowError(/Todo status must be one of/)
	})

	it("rejects invalid scope", () => {
		const state = createEmptyTodosSliceState()
		const badScopeParams = {
			action: "replace-list",
			scope: "bad",
			todos: [],
		} as unknown as WriteTodosParams
		expect(() => reduceReplaceList(state, badScopeParams)).toThrowError(/Invalid todo scope/)
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
		const firstScopeKey = getTodoScopeKey(GLOBAL_SCOPE)
		expect(state.byScope[firstScopeKey].todos).toEqual([
			{ id: 1, content: "alpha", status: "pending" },
			{ id: 4, content: "charlie", status: "pending" },
			{ id: 3, content: "bravo", status: "completed" },
		])

		const secondState = reduceReplaceList(state, {
			action: "replace-list",
			scope: GLOBAL_SCOPE,
			todos: [
				{ id: 3, content: "bravo updated", status: "completed" },
				{ content: "delta", status: "pending" },
			],
		}).state
		const secondScope = secondState.byScope[firstScopeKey]
		expect(secondScope.todos).toEqual([
			{ id: 5, content: "delta", status: "pending" },
			{ id: 3, content: "bravo updated", status: "completed" },
		])
	})

	it("keeps active todos above completed todos", () => {
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
			"active",
			"blocked",
			"pending",
			"done",
		])
	})

	it("clears scope when todos array is empty", () => {
		let state = createEmptyTodosSliceState()
		state = reduceReplaceList(state, {
			action: "replace-list",
			scope: STEP_SCOPE,
			todos: [{ content: "alpha", status: "pending" }],
		}).state
		const stepKey = getTodoScopeKey(STEP_SCOPE)
		expect(state.byScope[stepKey]).toBeDefined()

		const cleared = reduceReplaceList(state, {
			action: "replace-list",
			scope: STEP_SCOPE,
			todos: [],
		}).state
		expect(Object.hasOwn(cleared.byScope, stepKey)).toBe(false)
	})

	it("serializes details with schemaVersion, scope, todos, updatedAt", () => {
		const { details } = reduceReplaceList(createEmptyTodosSliceState(), {
			action: "replace-list",
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
			action: "replace-list",
			scope: STEP_SCOPE,
			todos: [{ content: "alpha", status: "completed" }],
		} as unknown as WriteTodosParams)
		expect(result.details.scope).toEqual(STEP_SCOPE)
	})
})
