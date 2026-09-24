import { isAgentWorker } from "../agent-worker-context.js"
import { isStaleCtxError } from "../stale-ctx.js"
import { createEmptyTodosSliceState, reduceReplaceList } from "./reducer.js"
import { getTodoScopeKey, normalizeTodoScope } from "./scope.js"
import type { TodoCounts, TodoItem, TodoScope, TodosSliceState, WriteTodosDetails, WriteTodosParams } from "./types.js"

export const GLOBAL_TODO_SCOPE: TodoScope = { kind: "global" }

export type TodoScopeProvider = () => TodoScope | undefined

/** Per-session todo state. Keyed by session id so that two concurrent keyed
 * sessions in the same process do not see each other's todos. */
const stateMap = new Map<string, TodosSliceState>()
const todoStoreListeners = new Set<(details: WriteTodosDetails, sessionId: string) => void>()
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

/**
 * Models sometimes pass a placeholder for "no scope" instead of omitting the
 * field — GLM-series models emit the literal string "{}" (and occasionally an
 * empty object). Normalize these to omission so providers can auto-scope the
 * write; otherwise they silently collapse to global and the ferment auto-scope
 * never engages (observed: GLM dumping all 83 todo writes into global across
 * a 21-step ferment because scope was "{}" on every call after the first).
 */
function isEmptyScopeInput(scopeInput: unknown): boolean {
	if (scopeInput === undefined || scopeInput === null) return true
	if (typeof scopeInput === "string") {
		const trimmed = scopeInput.trim()
		return trimmed === "" || trimmed === "{}"
	}
	if (typeof scopeInput === "object") {
		return Object.keys(scopeInput as Record<string, unknown>).length === 0
	}
	return false
}

export function resolveTodoScope(scopeInput?: unknown): TodoScope {
	if (!isEmptyScopeInput(scopeInput)) return normalizeTodoScope(scopeInput)

	// In-process subagent workers never inherit the orchestrator's active
	// ferment/step scope. Their scope-less writes always target global so
	// worker lists are task-local and never borrow the parent's lifecycle
	// labels (label only — the store is already keyed by session id).
	if (isAgentWorker()) return GLOBAL_TODO_SCOPE

	for (const provider of activeScopeProviders) {
		const scope = provider()
		if (scope) return scope
	}

	return GLOBAL_TODO_SCOPE
}

function resolveWriteTodoScope(params: WriteTodosParams): TodoScope {
	return resolveTodoScope(params.scope)
}

function notifyTodoStoreListeners(details: WriteTodosDetails, sessionId: string): void {
	// Isolate listener failures: the store is already updated when listeners
	// run, so an exception escaping here would surface as a bogus "Failed to
	// write todos" tool result even though the write landed (observed: a
	// listener leaked by a disposed session threw the stale-ctx error and the
	// model abandoned todo updates for the rest of that session).
	for (const listener of [...todoStoreListeners]) {
		try {
			listener(details, sessionId)
		} catch (error) {
			console.error("Todo store listener failed:", error)
			// A stale-ctx listener holds a disposed session's runtime and will
			// throw on every write forever — stop calling it. Generic errors may
			// be transient, so those listeners stay subscribed.
			if (isStaleCtxError(error)) {
				todoStoreListeners.delete(listener)
			}
		}
	}
}

export function applyWriteTodos(params: WriteTodosParams, sessionId: string): WriteTodosDetails {
	const scope = resolveWriteTodoScope(params)
	const current = getSessionState(sessionId)
	const result = reduceReplaceList(current, { ...params, scope })
	setSessionState(sessionId, result.state)

	notifyTodoStoreListeners(result.details, sessionId)
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

export function subscribeTodoStore(listener: (details: WriteTodosDetails, sessionId: string) => void): () => void {
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
