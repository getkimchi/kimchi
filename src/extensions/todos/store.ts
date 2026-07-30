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

/** Per-session count of non-todo tool calls since the last todo write.
 * Used by renderTodoStateMarkdown to show a passive staleness indicator. */
const toolCallsSinceTodoWrite = new Map<string, number>()

/** Per-session count of all non-todo tool calls, regardless of whether a todo
 * list exists. Used by the one-shot early nudge to detect multi-step work
 * without a todo list. Never reset (one-shot gate is `todoNudgeFired`). */
const workToolCallsSinceStart = new Map<string, number>()

/** Per-session flag: has this session ever had a todo list? Used to gate
 * the one-shot early nudge — only fires when no list has ever been created. */
const sessionsWithTodos = new Set<string>()

/** Per-session flag: has the one-shot early nudge already fired? Prevents
 * the nudge from recurring after it fires once. */
const todoNudgeFired = new Set<string>()

/** Tracks whether the todo list has been updated since creation (vs create-and-forget).
 * Reset to false on create, set to true on any subsequent write. */
const todoListEverUpdated = new Set<string>()

export function getToolCallsSinceTodoWrite(sessionId: string): number {
	return toolCallsSinceTodoWrite.get(sessionId) ?? 0
}

export function bumpToolCallsSinceTodoWrite(sessionId: string): void {
	toolCallsSinceTodoWrite.set(sessionId, (toolCallsSinceTodoWrite.get(sessionId) ?? 0) + 1)
}

/** Increment the cumulative count of non-todo tool calls for a session.
 * Used by the one-shot early nudge — always incremented, never reset. */
export function bumpWorkToolCalls(sessionId: string): void {
	workToolCallsSinceStart.set(sessionId, (workToolCallsSinceStart.get(sessionId) ?? 0) + 1)
}

/** Returns the cumulative count of non-todo tool calls for a session. */
export function getWorkToolCalls(sessionId: string): number {
	return workToolCallsSinceStart.get(sessionId) ?? 0
}

export function resetToolCallsSinceTodoWrite(sessionId: string): void {
	toolCallsSinceTodoWrite.set(sessionId, 0)
}

/** Returns true if this session has ever had any todos in its store. */
export function hasEverHadTodos(sessionId: string): boolean {
	return sessionsWithTodos.has(sessionId)
}

/** Returns true if the one-shot early nudge has already fired for this session. */
export function hasTodoNudgeFired(sessionId: string): boolean {
	return todoNudgeFired.has(sessionId)
}

/** Marks that the one-shot early nudge has fired for this session. */
export function markTodoNudgeFired(sessionId: string): void {
	todoNudgeFired.add(sessionId)
}

/** Returns true if the todo list has been updated since creation (not create-and-forget). */
export function hasTodoListBeenUpdated(sessionId: string): boolean {
	return todoListEverUpdated.has(sessionId)
}

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

function notifyTodoStoreListeners(details: WriteTodosDetails, sessionId: string): void {
	for (const listener of [...todoStoreListeners]) {
		listener(details, sessionId)
	}
}

export function applyWriteTodos(params: WriteTodosParams, sessionId: string): WriteTodosDetails {
	const scope = resolveWriteTodoScope(params)
	const current = getSessionState(sessionId)
	const result = reduceReplaceList(current, { ...params, scope })
	setSessionState(sessionId, result.state)

	// Track session state for nudge gating and create-and-forget detection.
	const hadTodosBefore = sessionsWithTodos.has(sessionId)
	const hasTodosAfter = result.details.todos.length > 0
	if (hasTodosAfter) {
		sessionsWithTodos.add(sessionId)
		// If the session already had todos, this is an update (not initial creation).
		if (hadTodosBefore) {
			todoListEverUpdated.add(sessionId)
		}
	} else if (hadTodosBefore) {
		// Clearing todos counts as an update.
		todoListEverUpdated.add(sessionId)
	}

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

	// Populate nudge/create-and-forget tracking so resumed sessions don't
	// get false positives. If the branch has any todos, the session has had
	// todos. If the branch has 2+ todo writes, the list has been updated.
	const hasAnyTodos = Object.values(restored.byScope).some((scope) => scope.todos.length > 0)
	if (hasAnyTodos) {
		sessionsWithTodos.add(sessionId)
	}
	if (details.length >= 2) {
		todoListEverUpdated.add(sessionId)
	}
}

export function __resetTodoStore(): void {
	stateMap.clear()
	activeScopeProviders.length = 0
	todoStoreListeners.clear()
	toolCallsSinceTodoWrite.clear()
	workToolCallsSinceStart.clear()
	sessionsWithTodos.clear()
	todoNudgeFired.clear()
	todoListEverUpdated.clear()
}
