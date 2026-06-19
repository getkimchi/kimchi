import { getTodoScopeKey, normalizeTodoScope } from "./scope.js"
import {
	TODO_STATUSES,
	TODO_TOOL_RESULT_SCHEMA_VERSION,
	type TodoDraft,
	type TodoItem,
	type TodoScope,
	type TodoStatus,
	type TodosSliceState,
	type WriteTodosDetails,
	type WriteTodosParams,
} from "./types.js"

export type { TodoItem, TodoScope, TodosSliceState, WriteTodosDetails, WriteTodosParams }

const FIRST_TODO_ID = 1

export interface ReplaceListResult {
	state: TodosSliceState
	details: WriteTodosDetails
}

function normalizeText(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : ""
	return text.length > 0 ? text : undefined
}

function normalizeStatus(value: unknown): TodoStatus {
	if (value === undefined) return "pending"
	const status = typeof value === "string" ? value.trim() : ""
	if (TODO_STATUSES.includes(status as TodoStatus)) return status as TodoStatus
	throw new Error(`Invalid todo status '${String(value)}'`)
}

function normalizeTodoId(value: unknown): number | undefined {
	if (value === undefined) return undefined
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error("Todo id must be a positive integer when provided")
	}
	return value
}

function normalizeOptionalText(value: unknown): string | undefined {
	if (value === undefined) return undefined
	const text = normalizeText(value)
	return text && text.length > 0 ? text : undefined
}

function orderTodosForStorage(todos: readonly TodoItem[]): TodoItem[] {
	return [...todos].sort((a, b) => a.id - b.id)
}

function normalizeIncomingTodos(scopeTodos: unknown, nextId: number): { todos: TodoItem[]; nextTodoId: number } {
	if (!Array.isArray(scopeTodos)) {
		throw new Error("Todo list must be an array")
	}

	const usedIds = new Set<number>()
	let currentNextId = Number.isInteger(nextId) && nextId > 0 ? nextId : FIRST_TODO_ID
	const result: TodoItem[] = []

	for (const rawTodo of scopeTodos) {
		if (!rawTodo || typeof rawTodo !== "object") {
			throw new Error("Todo entries must be objects")
		}

		const todo = rawTodo as TodoDraft
		const content = normalizeText(todo.content)
		if (!content) continue

		const status = normalizeStatus(todo.status)
		let id = normalizeTodoId(todo.id)

		if (id === undefined) {
			while (usedIds.has(currentNextId)) currentNextId += 1
			id = currentNextId
			currentNextId += 1
		}

		if (usedIds.has(id)) {
			throw new Error(`Duplicate todo id '${id}'`)
		}
		usedIds.add(id)
		currentNextId = Math.max(currentNextId, id + 1)

		const activeForm = normalizeOptionalText(todo.activeForm)
		const note = normalizeOptionalText(todo.note)
		result.push({ id, content, status, ...(activeForm ? { activeForm } : {}), ...(note ? { note } : {}) })
	}

	return { todos: orderTodosForStorage(result), nextTodoId: currentNextId }
}

export function createEmptyTodosSliceState(): TodosSliceState {
	return { byScope: {} }
}

export function reduceReplaceList(
	state: TodosSliceState,
	params: WriteTodosParams & { action?: unknown },
): ReplaceListResult {
	if (params.action !== undefined && params.action !== "replace-list") {
		throw new Error(`Unsupported todo action '${String(params.action)}'`)
	}

	const scope = normalizeTodoScope(params.scope)
	const scopeKey = getTodoScopeKey(scope)
	const existing = state.byScope[scopeKey]
	const nextTodoId = existing?.nextId ?? FIRST_TODO_ID
	const normalized = normalizeIncomingTodos(params.todos, nextTodoId)
	const nextState: TodosSliceState = { byScope: { ...state.byScope } }

	if (normalized.todos.length === 0) {
		delete nextState.byScope[scopeKey]
		return {
			state: nextState,
			details: {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope,
				todos: [],
				updatedAt: new Date().toISOString(),
			},
		}
	}

	nextState.byScope[scopeKey] = {
		nextId: normalized.nextTodoId,
		todos: normalized.todos,
	}

	return {
		state: nextState,
		details: {
			schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
			scope,
			todos: normalized.todos,
			updatedAt: new Date().toISOString(),
		},
	}
}

export function reduceTodos(state: TodosSliceState, params: WriteTodosParams): ReplaceListResult {
	return reduceReplaceList(state, params)
}
