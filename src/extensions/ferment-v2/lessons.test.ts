import { describe, expect, it } from "vitest"
import type { TodoItem } from "../todos/types.js"
import {
	type FermentV2Lesson,
	MAX_FERMENT_V2_LESSON_CHARS,
	MAX_FERMENT_V2_LESSONS,
	updateFermentV2Lessons,
} from "./lessons.js"

function todo(id: number, status: TodoItem["status"], note?: string): TodoItem {
	return { id, content: `Todo ${id}`, status, ...(note ? { note } : {}) }
}

describe("Ferment V2 lessons", () => {
	it("keeps terminal todo notes after the todo leaves the current list", () => {
		const lessons = updateFermentV2Lessons([], [todo(1, "completed", "Decision: keep the native session journal")])

		expect(lessons).toEqual([{ todoId: 1, kind: "decision", text: "keep the native session journal" }])
		expect(updateFermentV2Lessons(lessons, [])).toEqual(lessons)
	})

	it("does not treat unprefixed completed notes as evidence", () => {
		expect(
			updateFermentV2Lessons(
				[],
				[todo(1, "completed", "Focused tests passed"), todo(2, "blocked", "Provider credentials are unavailable")],
			),
		).toEqual([
			{ todoId: 1, kind: "decision", text: "Focused tests passed" },
			{ todoId: 2, kind: "dead-end", text: "Provider credentials are unavailable" },
		])
	})

	it("caps oversized terminal notes while preserving their kind", () => {
		const note = `Evidence: ${"x".repeat(MAX_FERMENT_V2_LESSON_CHARS + 1)}TAIL`

		expect(updateFermentV2Lessons([], [todo(1, "completed", note)])).toEqual([
			{ todoId: 1, kind: "evidence", text: "x".repeat(MAX_FERMENT_V2_LESSON_CHARS) },
		])
	})

	it("replaces a todo's lesson and removes it when the todo is reopened", () => {
		const lessons = updateFermentV2Lessons([], [todo(1, "completed", "Evidence: initial tests passed")])
		const updated = updateFermentV2Lessons(lessons, [todo(1, "completed", "Evidence: focused tests passed")])

		expect(updated).toEqual([{ todoId: 1, kind: "evidence", text: "focused tests passed" }])
		expect(updateFermentV2Lessons(updated, [todo(1, "in_progress", "Rechecking")])).toEqual([])
	})

	it("keeps only the most recent lessons", () => {
		const lessons = Array.from({ length: MAX_FERMENT_V2_LESSONS + 2 }, (_, index) =>
			todo(index + 1, "completed", `Evidence: result ${index + 1}`),
		).reduce<FermentV2Lesson[]>((current, item) => updateFermentV2Lessons(current, [item]), [])

		expect(lessons).toHaveLength(MAX_FERMENT_V2_LESSONS)
		expect(lessons.map(({ text }) => text)).toEqual(["result 3", "result 4", "result 5", "result 6", "result 7"])
	})
})
