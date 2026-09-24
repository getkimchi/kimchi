import { describe, expect, it } from "vitest"
import type { TodoItem } from "../todos/types.js"
import { createFermentV2 } from "./reducer.js"
import { deriveSettledStatus, isStatusOnlyTodoSettlement, rebindTodoState, todoCounts } from "./runtime-policy.js"

describe("cancelled Ferment todos", () => {
	it.each([
		{ status: "completed", expected: "complete" },
		{ status: "blocked", expected: "blocked" },
		{ status: "pending", expected: undefined },
		{ status: "in_progress", expected: undefined },
	] as const)("closes superseded work while preserving a $status replacement", ({ status, expected }) => {
		const counts = todoCounts([{ status: "cancelled" }, { status }])
		expect(counts).toEqual({
			total: 2,
			cancelled: 1,
			blocked: Number(status === "blocked"),
			completed: Number(status === "completed"),
		})
		expect(deriveSettledStatus(counts, undefined)).toBe(expected)
		const run = createFermentV2(undefined, "Do work", "run", new Date().toISOString())
		expect(
			rebindTodoState({ ...counts, sessionId: "s", fermentV2Id: run.id, revision: 1, todos: [] }, run).cancelled,
		).toBe(1)
	})

	it("allows cancellation bookkeeping but invalidates acceptance when its reason changes", () => {
		const before: TodoItem[] = [{ id: 1, content: "Old approach", status: "in_progress", note: "Replaced by auto" }]
		const after: TodoItem[] = [{ ...before[0], status: "cancelled" }]
		expect(isStatusOnlyTodoSettlement(before, after)).toBe(true)
		expect(isStatusOnlyTodoSettlement(before, [{ ...after[0], note: "Different replacement" }])).toBe(false)
	})
})
