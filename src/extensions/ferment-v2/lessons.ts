import type { TodoItem } from "../todos/types.js"

export const MAX_FERMENT_V2_LESSONS = 5
export const MAX_FERMENT_V2_LESSON_CHARS = 1_000

export type FermentV2LessonKind = "decision" | "evidence" | "dead-end"

export interface FermentV2Lesson {
	todoId: number
	kind: FermentV2LessonKind
	text: string
}

const NOTE_KIND_PREFIX = /^(decision|evidence|dead(?:[ -]?end))\s*:\s*/i

export function updateFermentV2Lessons(
	previous: readonly FermentV2Lesson[],
	todos: readonly TodoItem[],
): FermentV2Lesson[] {
	let lessons = [...previous]
	for (const todo of todos) {
		const lesson = lessonFromTodo(todo)
		lessons = lessons.filter((current) => current.todoId !== todo.id)
		if (lesson) lessons.push(lesson)
	}
	return lessons.slice(-MAX_FERMENT_V2_LESSONS)
}

function lessonFromTodo(todo: TodoItem): FermentV2Lesson | undefined {
	if ((todo.status !== "completed" && todo.status !== "blocked") || !todo.note?.trim()) return undefined

	const note = todo.note.trim()
	const prefix = note.match(NOTE_KIND_PREFIX)
	const kind = prefix ? normalizeKind(prefix[1]) : todo.status === "blocked" ? "dead-end" : "decision"
	const text = (prefix ? note.slice(prefix[0].length).trim() : note).slice(0, MAX_FERMENT_V2_LESSON_CHARS)
	return text ? { todoId: todo.id, kind, text } : undefined
}

function normalizeKind(value: string): FermentV2LessonKind {
	const normalized = value.toLowerCase()
	if (normalized === "decision") return "decision"
	if (normalized === "evidence") return "evidence"
	return "dead-end"
}
