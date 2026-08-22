import { describe, expect, it } from "vitest"
import type { TodoItem } from "../todos/types.js"
import { type GoalLesson, MAX_GOAL_LESSONS, updateGoalLessons } from "./lessons.js"

function todo(id: number, status: TodoItem["status"], note?: string): TodoItem {
	return { id, content: `Todo ${id}`, status, ...(note ? { note } : {}) }
}

describe("goal lessons", () => {
	it("keeps terminal todo notes after the todo leaves the current list", () => {
		const lessons = updateGoalLessons([], [todo(1, "completed", "Decision: keep the native session journal")])

		expect(lessons).toEqual([{ todoId: 1, kind: "decision", text: "keep the native session journal" }])
		expect(updateGoalLessons(lessons, [])).toEqual(lessons)
	})

	it("labels unprefixed completed and blocked notes distinctly", () => {
		expect(
			updateGoalLessons(
				[],
				[todo(1, "completed", "Focused tests passed"), todo(2, "blocked", "Provider credentials are unavailable")],
			),
		).toEqual([
			{ todoId: 1, kind: "evidence", text: "Focused tests passed" },
			{ todoId: 2, kind: "dead-end", text: "Provider credentials are unavailable" },
		])
	})

	it("replaces a todo's lesson and removes it when the todo is reopened", () => {
		const lessons = updateGoalLessons([], [todo(1, "completed", "Evidence: initial tests passed")])
		const updated = updateGoalLessons(lessons, [todo(1, "completed", "Evidence: focused tests passed")])

		expect(updated).toEqual([{ todoId: 1, kind: "evidence", text: "focused tests passed" }])
		expect(updateGoalLessons(updated, [todo(1, "in_progress", "Rechecking")])).toEqual([])
	})

	it("keeps only the most recent lessons", () => {
		const lessons = Array.from({ length: MAX_GOAL_LESSONS + 2 }, (_, index) =>
			todo(index + 1, "completed", `Evidence: result ${index + 1}`),
		).reduce<GoalLesson[]>((current, item) => updateGoalLessons(current, [item]), [])

		expect(lessons).toHaveLength(MAX_GOAL_LESSONS)
		expect(lessons.map(({ text }) => text)).toEqual(["result 3", "result 4", "result 5", "result 6", "result 7"])
	})
})
