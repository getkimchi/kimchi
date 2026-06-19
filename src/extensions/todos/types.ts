export const TODO_TOOL_RESULT_SCHEMA_VERSION = 1 as const

export const TODO_STATUSES = ["pending", "in_progress", "blocked", "completed"] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export interface TodoScopeGlobal {
	kind: "global"
}

export interface TodoScopeFerment {
	kind: "ferment"
	phaseId: string
}

export interface TodoScopeFermentStep {
	kind: "ferment-step"
	phaseId: string
	stepId: string
}

// Part 1 had one scope. Part 2 adds ferment scope. Further parts may widen this union.
export type TodoScope = TodoScopeGlobal | TodoScopeFerment | TodoScopeFermentStep

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
