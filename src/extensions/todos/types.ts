export const TODO_TOOL_RESULT_SCHEMA_VERSION = 1 as const

export const TODO_STATUSES = ["pending", "in_progress", "blocked", "completed"] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export interface TodoScopeGlobal {
	kind: "global"
}

// Part 1 has one scope. Later parts widen this union explicitly.
export type TodoScope = TodoScopeGlobal

export interface TodoDraft {
	id?: number
	content: string
	status: TodoStatus
	activeForm?: string
	note?: string
}

export interface TodoItem {
	id: number
	content: string
	status: TodoStatus
	activeForm?: string
	note?: string
}

export interface TodoScopeState {
	nextId: number
	todos: TodoItem[]
}

export interface TodosSliceState {
	byScope: Record<string, TodoScopeState>
}

export interface TodoCounts {
	total: number
	completed: number
	pending: number
	blocked: number
	inProgress: number
}

export interface WriteTodosParams {
	scope?: unknown
	todos: TodoDraft[]
}

export interface WriteTodosDetails {
	schemaVersion: typeof TODO_TOOL_RESULT_SCHEMA_VERSION
	scope: TodoScope
	todos: TodoItem[]
	updatedAt: string
}
