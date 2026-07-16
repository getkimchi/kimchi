import { createEmptyTodosSliceState, reduceReplaceList } from "./reducer.js"
import { getTodoScopeKey, normalizeTodoScope } from "./scope.js"
import type { TodoCounts, TodoItem, TodoScope, TodosSliceState, WriteTodosDetails, WriteTodosParams } from "./types.js"

export const GLOBAL_TODO_SCOPE: TodoScope = { kind: "global" }

export type TodoScopeProvider = () => TodoScope | undefined

/** Per-session todo state. Keyed by session id so that two concurrent keyed
 * sessions in the same process do not see each other's todos. */
const stateMap = new Map<string, TodosSliceState>()
const todoStoreListeners = new Set<(details: WriteTodosDetails) => void>()
const activeScopeProviders: TodoScopeProvider[] = []

function getSessionState(sessionId: string): TodosSliceState {
	const existing = stateMap.get(sessionId)
	if (existing) {
		return existing
	}
	const created = createEmptyTodosSliceState()
	stateMap.set(sessionId, created)
	return created
}

function setSessionState(sessionId: string, next: TodosSliceState): void {
	stateMap.set(sessionId, next)
}

export function getTodoState(sessionId: string): TodosSliceState {
	return getSessionState(sessionId)
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

export function applyWriteTodos(params: WriteTodosParams, sessionId: string): WriteTodosDetails {
	const scope = resolveWriteTodoScope(params)
	const current = getSessionState(sessionId)
	const result = reduceReplaceList(current, { ...params, scope })
	setSessionState(sessionId, result.state)
	notifyTodoStoreListeners(result.details)
	return result.details
}

export function getTodosForScope(scope: TodoScope, sessionId: string): TodoItem[] {
	return getSessionState(sessionId).byScope[getTodoScopeKey(scope)]?.todos ?? []
}

export function getTodoCountsForScope(scope: TodoScope, sessionId: string): TodoCounts {
	const todos = getTodosForScope(scope, sessionId)
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

export function clearTodoStore(sessionId: string): void {
	stateMap.delete(sessionId)
}

export function restoreTodoStoreFromDetails(details: readonly WriteTodosDetails[], sessionId: string): void {
	let restored = createEmptyTodosSliceState()
	for (const detail of details) {
		restored = reduceReplaceList(restored, { scope: detail.scope, todos: detail.todos }).state
	}
	setSessionState(sessionId, restored)
}

export function __resetTodoStore(): void {
	stateMap.clear()
	activeScopeProviders.length = 0
	todoStoreListeners.clear()
}
