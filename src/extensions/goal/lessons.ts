import type { TodoItem } from "../todos/types.js"

export const MAX_GOAL_LESSONS = 5

export type GoalLessonKind = "decision" | "evidence" | "dead-end"

export interface GoalLesson {
	todoId: number
	kind: GoalLessonKind
	text: string
}

const NOTE_KIND_PREFIX = /^(decision|evidence|dead(?:[ -]?end))\s*:\s*/i

export function updateGoalLessons(previous: readonly GoalLesson[], todos: readonly TodoItem[]): GoalLesson[] {
	let lessons = [...previous]
	for (const todo of todos) {
		const lesson = lessonFromTodo(todo)
		lessons = lessons.filter((current) => current.todoId !== todo.id)
		if (lesson) lessons.push(lesson)
	}
	return lessons.slice(-MAX_GOAL_LESSONS)
}

function lessonFromTodo(todo: TodoItem): GoalLesson | undefined {
	if ((todo.status !== "completed" && todo.status !== "blocked") || !todo.note?.trim()) return undefined

	const note = todo.note.trim()
	const prefix = note.match(NOTE_KIND_PREFIX)
	const kind = prefix ? normalizeKind(prefix[1]) : todo.status === "blocked" ? "dead-end" : "evidence"
	const text = prefix ? note.slice(prefix[0].length).trim() : note
	return text ? { todoId: todo.id, kind, text } : undefined
}

function normalizeKind(value: string): GoalLessonKind {
	const normalized = value.toLowerCase()
	if (normalized === "decision") return "decision"
	if (normalized === "evidence") return "evidence"
	return "dead-end"
}
