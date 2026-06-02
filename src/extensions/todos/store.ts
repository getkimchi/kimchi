import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolveFermentsDir } from "../../ferment/store.js"
import { getAgentWorkerId, getAgentWorkerLabel, isAgentWorker } from "../agent-worker-context.js"
import { isSubagentInternalTodosRuntimeEnabled } from "../agents/internal-todos.js"
import { createEmptyTodosSliceState, reduceReplaceList } from "./reducer.js"
import { getTodoScopeKey, normalizeTodoScope, parseTodoScopeKey, todoScopeFromFermentScope } from "./scope.js"
import type {
	AgentTodoBoard,
	FermentTodoScope,
	TodoCounts,
	TodoItem,
	TodoScope,
	TodosSliceState,
	WriteTodosDetails,
	WriteTodosParams,
	WriteTodosScope,
} from "./types.js"

type ActiveScopeProvider = () => FermentTodoScope | undefined

let state: TodosSliceState = createEmptyTodosSliceState()
let activeScopeProvider: ActiveScopeProvider | undefined
const agentTodoLabels = new Map<string, string>()

export const GLOBAL_TODO_SCOPE: TodoScope = { kind: "global" }

export function __resetTodoStore(): void {
	clearTodoStore()
	activeScopeProvider = undefined
}

export function clearTodoStore(): void {
	state = createEmptyTodosSliceState()
	agentTodoLabels.clear()
}

export function clearAgentTodos(agentId?: string): void {
	const next: TodosSliceState = { byScope: { ...state.byScope } }
	for (const key of Object.keys(next.byScope)) {
		try {
			const scope = parseTodoScopeKey(key)
			if (scope.kind === "agent" && (agentId === undefined || scope.agentId === agentId)) {
				delete next.byScope[key]
			}
		} catch {}
	}
	state = next
}

export function setActiveFermentTodoScopeProvider(provider: ActiveScopeProvider | undefined): void {
	activeScopeProvider = provider
}

export function getTodoState(): TodosSliceState {
	return state
}

export function replaceTodoState(next: TodosSliceState): void {
	state = next
}

export function resolveTodoScope(scope?: WriteTodosScope): TodoScope {
	if (scope) return normalizeTodoScope(scope)
	return getActiveTodoScope() ?? GLOBAL_TODO_SCOPE
}

export function getTodosForScope(scope?: WriteTodosScope): TodoItem[] {
	const resolved = resolveTodoScope(scope)
	return [...(state.byScope[getTodoScopeKey(resolved)]?.todos ?? [])]
}

export function getTodoCountsForScope(scope?: WriteTodosScope): TodoCounts {
	const todos = getTodosForScope(scope)
	return countTodos(todos)
}

function countTodos(todos: readonly TodoItem[]): TodoCounts {
	return {
		total: todos.length,
		completed: todos.filter((todo) => todo.status === "completed").length,
		pending: todos.filter((todo) => todo.status === "pending").length,
		blocked: todos.filter((todo) => todo.status === "blocked").length,
		inProgress: todos.filter((todo) => todo.status === "in_progress").length,
	}
}

export function applyWriteTodos(params: WriteTodosParams): WriteTodosDetails {
	const scope = resolveWriteTodoScope(params.scope)
	if (scope.kind === "agent") rememberAgentTodoLabel(scope.agentId, getAgentWorkerLabel())
	const result = reduceReplaceList(state, { ...params, scope })
	state = result.state
	if (isFermentTodoScope(scope)) persistFermentTodos(scope.fermentId)
	return result.details
}

export function resolveTodoDisplayScope(): TodoScope {
	const active = activeScopeProvider?.()
	return active ? (todoScopeFromFermentScope(active) ?? GLOBAL_TODO_SCOPE) : GLOBAL_TODO_SCOPE
}

export function getAgentTodoBoards(): AgentTodoBoard[] {
	const boards: AgentTodoBoard[] = []
	for (const [key, value] of Object.entries(state.byScope)) {
		try {
			const scope = parseTodoScopeKey(key)
			if (scope.kind !== "agent" || value.todos.length === 0) continue
			boards.push({
				agentId: scope.agentId,
				label: agentTodoLabels.get(scope.agentId) ?? shortAgentId(scope.agentId),
				counts: countTodos(value.todos),
				todos: [...value.todos],
			})
		} catch {}
	}
	return boards.sort(
		(left, right) => left.label.localeCompare(right.label) || left.agentId.localeCompare(right.agentId),
	)
}

function rememberAgentTodoLabel(agentId: string, label: string | undefined): void {
	const text = label?.trim()
	if (text) agentTodoLabels.set(agentId, text)
}

function shortAgentId(agentId: string): string {
	return agentId.length > 8 ? agentId.slice(0, 8) : agentId
}

function resolveWriteTodoScope(scope?: WriteTodosScope): TodoScope {
	const active = getActiveTodoScope()
	const resolved = scope ? normalizeTodoScope(scope) : (active ?? GLOBAL_TODO_SCOPE)
	if (active?.kind === "agent" && resolved.kind === "global") return active
	if (resolved.kind !== "ferment") return resolved

	const fermentActive = activeScopeProvider?.()
	const scoped = fermentActive ? todoScopeFromFermentScope(fermentActive) : undefined
	if (scoped?.kind === "ferment_step" && scoped.fermentId === resolved.fermentId) return scoped
	return resolved
}

function getActiveTodoScope(): TodoScope | undefined {
	const agentScope = getActiveAgentTodoScope()
	if (agentScope) return agentScope
	const active = activeScopeProvider?.()
	return active ? todoScopeFromFermentScope(active) : undefined
}

function getActiveAgentTodoScope(): TodoScope | undefined {
	if (!isAgentWorker() || !isSubagentInternalTodosRuntimeEnabled()) return undefined
	return { kind: "agent", agentId: getAgentWorkerId() ?? "subagent" }
}

function isFermentTodoScope(scope: TodoScope): scope is Exclude<TodoScope, { kind: "global" | "agent" }> {
	return scope.kind === "ferment" || scope.kind === "ferment_phase" || scope.kind === "ferment_step"
}

export function hydrateFermentTodos(fermentId: string, root?: string): void {
	const filePath = getFermentTodosPath(fermentId, root)
	if (!existsSync(filePath)) return
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown
		if (!parsed || typeof parsed !== "object" || !("byScope" in parsed)) return
		state = { byScope: { ...state.byScope, ...(parsed as TodosSliceState).byScope } }
	} catch {
		return
	}
}

function persistFermentTodos(fermentId: string, root?: string): void {
	const scoped: TodosSliceState = { byScope: {} }
	for (const [key, value] of Object.entries(state.byScope)) {
		try {
			const scope = parseTodoScopeKey(key)
			if (isFermentTodoScope(scope) && scope.fermentId === fermentId) scoped.byScope[key] = value
		} catch {}
	}
	const filePath = getFermentTodosPath(fermentId, root)
	mkdirSync(dirname(filePath), { recursive: true })
	writeFileSync(filePath, `${JSON.stringify(scoped, null, 2)}\n`, "utf8")
}

function getFermentTodosPath(fermentId: string, root?: string): string {
	return join(resolveFermentsDir(root), fermentId, "todos.json")
}
