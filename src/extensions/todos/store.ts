import { createEmptyTodosSliceState, reduceReplaceList } from "./reducer.js"
import { getTodoScopeKey, normalizeTodoScope } from "./scope.js"
import type { TodoCounts, TodoItem, TodoScope, TodosSliceState, WriteTodosDetails, WriteTodosParams } from "./types.js"

export const GLOBAL_TODO_SCOPE: TodoScope = { kind: "global" }

export type TodoScopeProvider = () => TodoScope | undefined

let state = createEmptyTodosSliceState()
const todoStoreListeners = new Set<(details: WriteTodosDetails) => void>()
const activeScopeProviders: TodoScopeProvider[] = []

export function getTodoState(): TodosSliceState {
	return state
}

export function resolveTodoScope(scopeInput?: unknown): TodoScope {
	if (scopeInput !== undefined) return normalizeTodoScope(scopeInput)

	for (const provider of activeScopeProviders) {
		const scope = provider()
		if (scope) return scope
	}

	return GLOBAL_TODO_SCOPE
}

function resolveWriteTodoScope(params: WriteTodosParams): TodoScope {
	return resolveTodoScope(params.scope)
}

function notifyTodoStoreListeners(details: WriteTodosDetails): void {
	for (const listener of [...todoStoreListeners]) {
		listener(details)
	}
}

export function applyWriteTodos(params: WriteTodosParams): WriteTodosDetails {
	const scope = resolveWriteTodoScope(params)
	const result = reduceReplaceList(state, { ...params, scope })
	state = result.state
	notifyTodoStoreListeners(result.details)
	return result.details
}

export function getTodosForScope(scope: TodoScope = GLOBAL_TODO_SCOPE): TodoItem[] {
	return state.byScope[getTodoScopeKey(scope)]?.todos ?? []
}

export function getTodoCountsForScope(scope: TodoScope = GLOBAL_TODO_SCOPE): TodoCounts {
	const todos = getTodosForScope(scope)
	return {
		total: todos.length,
		completed: todos.filter((todo) => todo.status === "completed").length,
		pending: todos.filter((todo) => todo.status === "pending").length,
		blocked: todos.filter((todo) => todo.status === "blocked").length,
		inProgress: todos.filter((todo) => todo.status === "in_progress").length,
	}
}

export function subscribeTodoStore(listener: (details: WriteTodosDetails) => void): () => void {
	todoStoreListeners.add(listener)
	return () => {
		todoStoreListeners.delete(listener)
	}
}

export function registerActiveTodoScopeProvider(provider: TodoScopeProvider): () => void {
	activeScopeProviders.push(provider)
	return () => {
		const index = activeScopeProviders.indexOf(provider)
		if (index >= 0) activeScopeProviders.splice(index, 1)
	}
}

export function clearTodoStore(): void {
	state = createEmptyTodosSliceState()
}

export function restoreTodoStoreFromDetails(details: readonly WriteTodosDetails[]): void {
	let restored = createEmptyTodosSliceState()
	for (const detail of details) {
		restored = reduceReplaceList(restored, { scope: detail.scope, todos: detail.todos }).state
	}
	state = restored
}

export function __resetTodoStore(): void {
	clearTodoStore()
	activeScopeProviders.length = 0
	todoStoreListeners.clear()
}
