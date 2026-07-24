import { describe, expect, it } from "vitest"
import {
	addGoalAccounting,
	clearGoal,
	clearGoalEntry,
	createGoal,
	editGoal,
	putGoalEntry,
	replaceGoal,
	restoreGoal,
	setGoalStatus,
} from "./reducer.js"

const T1 = "2026-07-16T10:00:00.000Z"
const T2 = "2026-07-16T10:01:00.000Z"

describe("goal reducer", () => {
	it("creates revision one and preserves meaningful internal whitespace", () => {
		const goal = createGoal(undefined, "  first line\n\n  second line  ", "goal-a", T1)

		expect(goal).toEqual({
			schemaVersion: 1,
			id: "goal-a",
			revision: 1,
			objective: "first line\n\n  second line",
			status: "active",
			tokensUsed: 0,
			timeUsedMs: 0,
			createdAt: T1,
			updatedAt: T1,
		})
	})

	it("rejects empty objectives", () => {
		expect(() => createGoal(undefined, " \n ", "goal-a", T1)).toThrow("Goal objective cannot be empty")
	})

	it("edits in place by incrementing revision and preserving status", () => {
		const paused = setGoalStatus(createGoal(undefined, "old", "goal-a", T1), "goal-a", 1, "paused", T2)
		const edited = editGoal(paused, "goal-a", 1, "new", T2)

		expect(edited).toMatchObject({ id: "goal-a", revision: 2, objective: "new", status: "paused" })
		expect(edited.createdAt).toBe(T1)
	})

	it("replaces with a new ID, revision one, and active status", () => {
		const complete = setGoalStatus(createGoal(undefined, "old", "goal-a", T1), "goal-a", 1, "complete", T2)
		const replacement = replaceGoal(complete, "new", "goal-b", T2)

		expect(replacement).toMatchObject({ id: "goal-b", revision: 1, objective: "new", status: "active" })
	})

	it("rejects stale IDs and revisions", () => {
		const goal = createGoal(undefined, "old", "goal-a", T1)

		expect(() => editGoal(goal, "goal-b", 1, "new", T2)).toThrow(/current goal is goal-a revision 1/)
		expect(() => setGoalStatus(goal, "goal-a", 2, "complete", T2)).toThrow(/current goal is goal-a revision 1/)
		expect(() => clearGoal(undefined, "goal-a", 1)).toThrow("no current goal exists")
	})

	it("accumulates goal time and tokens while rejecting another goal ID", () => {
		const goal = createGoal(undefined, "old", "goal-a", T1, 1_500)
		const active = addGoalAccounting(goal, "goal-a", 1_499, 2_000, T2)
		const accounted = addGoalAccounting(active, "goal-a", 1, 500, T2)

		expect(active).toMatchObject({ status: "active", tokenBudget: 1_500 })
		expect(accounted).toMatchObject({
			status: "budget_limited",
			tokenBudget: 1_500,
			tokensUsed: 1_500,
			timeUsedMs: 2_500,
			updatedAt: T2,
		})
		expect(() => addGoalAccounting(accounted, "goal-b", 1, 1, T2)).toThrow(/current goal is goal-a/)
	})

	it("replays puts and matching clear tombstones in branch order", () => {
		const revision1 = createGoal(undefined, "one", "goal-a", T1)
		const revision2 = editGoal(revision1, "goal-a", 1, "two", T2)
		const unrelatedClear = clearGoalEntry({ ...revision2, id: "other" }, T2)

		expect(restoreGoal([{ bad: true }, putGoalEntry(revision1), putGoalEntry(revision2), unrelatedClear])).toEqual(
			revision2,
		)
		expect(
			restoreGoal([putGoalEntry(revision1), putGoalEntry(revision2), clearGoalEntry(revision2, T2)]),
		).toBeUndefined()
	})
})
