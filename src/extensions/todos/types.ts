export const TODO_TOOL_RESULT_SCHEMA_VERSION = 1 as const

export const TODO_STATUSES = ["pending", "in_progress", "blocked", "completed"] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]

export interface TodoScopeGlobal {
	kind: "global"
}

export interface TodoScopeFerment {
	kind: "ferment"
	fermentId: string
}

export interface TodoScopeFermentPhase {
	kind: "ferment_phase"
	fermentId: string
	phaseId: string
}

export interface TodoScopeFermentStep {
	kind: "ferment_step"
	fermentId: string
	phaseId: string
	stepId: string
}

export interface TodoScopeAgent {
	kind: "agent"
	agentId: string
}

export interface TodoScopePhaseAlias {
	kind: "phase"
	fermentId: string
	phaseId: string
}

export interface TodoScopeStepAlias {
	kind: "step"
	fermentId: string
	phaseId: string
	stepId: string
}

export type TodoScope =
	| TodoScopeGlobal
	| TodoScopeFerment
	| TodoScopeFermentPhase
	| TodoScopeFermentStep
	| TodoScopeAgent

export type WriteTodosScope = TodoScope | TodoScopePhaseAlias | TodoScopeStepAlias

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

export interface WriteTodosParams {
	scope?: WriteTodosScope
	todos: TodoDraft[]
}

export interface WriteTodosDetails {
	schemaVersion: typeof TODO_TOOL_RESULT_SCHEMA_VERSION
	scope: TodoScope
	todos: TodoItem[]
	updatedAt: string
}

export interface TodosSliceState {
	byScope: Record<string, TodoScopeState>
}

export interface TodoScopeState {
	nextId: number
	todos: TodoItem[]
}

export interface TodoCounts {
	total: number
	completed: number
	pending: number
	blocked: number
	inProgress: number
}

export interface AgentTodoBoard {
	agentId: string
	label: string
	counts: TodoCounts
	todos: TodoItem[]
}

export type TodoScopeLevel = "ferment" | "phase" | "step"

export interface FermentTodoScope {
	level: TodoScopeLevel
	fermentId: string
	phaseId?: string
	stepId?: string
}

export type FermentTodoCounts = TodoCounts
