import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { Key, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import { GLOBAL_TODO_SCOPE, getTodoCountsForScope, getTodosForScope, resolveTodoScope } from "./store.js"
import type { TodoCounts, TodoItem, TodoScope, TodoStatus } from "./types.js"

export const TODO_SHORTCUT = Key.f7
export const TODO_SHORTCUT_HINT = "F7"

const TODO_WIDGET_KEY = "kimchi-todos"
const TODO_WIDGET_OPTIONS = { placement: "aboveEditor" } as const
const TODO_STATUS_KEY = "todos"
const TODO_LIST_HINT_TEXT = "F7 or enter '/todos' to collapse"
const MAX_TODO_WIDGET_LINES = 14
const TODO_WIDGET_BODY_LINES = 10
const TODO_WIDGET_ROLL_THRESHOLD = TODO_WIDGET_BODY_LINES - 1
const MAX_ROLLED_TODO_ROWS = 5
const MAX_ROLLED_CONTEXT_ROWS = 2
const TODO_SYMBOL: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "▶",
	blocked: "!",
	completed: "✓",
}

interface TodoWidgetState {
	visible: boolean
	expanded: boolean
	collapsed: boolean
	registered: boolean
	registrationId: number
	ctx?: ExtensionContext
	tui?: { requestRender?: (force?: boolean) => void }
}

const todoWidgetStates = new Map<string, TodoWidgetState>()
let activeTodoWidgetSessionId: string | undefined

function createTodoWidgetState(): TodoWidgetState {
	return { visible: false, expanded: false, collapsed: false, registered: false, registrationId: 0 }
}

function todoWidgetSessionId(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionId()
}

function getTodoWidgetState(ctx: ExtensionContext): TodoWidgetState {
	const sessionId = todoWidgetSessionId(ctx)
	let state = todoWidgetStates.get(sessionId)
	if (!state) {
		state = createTodoWidgetState()
		todoWidgetStates.set(sessionId, state)
	}
	activeTodoWidgetSessionId = sessionId
	return state
}

export function summarizeTodoCounts(counts: TodoCounts): string {
	if (counts.total === 0) return "No todos"
	const active = counts.pending + counts.inProgress + counts.blocked
	const blocked = counts.blocked > 0 ? ` · ${counts.blocked} blocked` : ""
	return `${counts.completed}/${counts.total} done · ${active} active${blocked}`
}

function hasActiveTodos(counts: TodoCounts): boolean {
	return counts.pending + counts.inProgress + counts.blocked > 0
}

export function summarizeTodos(): string {
	return summarizeTodoCounts(getTodoCountsForScope(GLOBAL_TODO_SCOPE))
}

function isFermentTodo(todo: TodoItem): boolean {
	return todo.content.startsWith("↳ ") || todo.content.startsWith("[Phase ")
}

function todoLine(todo: TodoItem, displayIndex: number, theme: Theme, scope: TodoScope): string {
	const index = `${displayIndex + 1}`.padStart(2)
	const symbol = TODO_SYMBOL[todo.status]
	const isFerment = scope.kind === "ferment" || isFermentTodo(todo)

	// Phase header — bold accent
	if (isFerment && todo.content.startsWith("[Phase ")) {
		if (todo.status === "completed") {
			return ` ${index}.  ${theme.fg("success", symbol)} ${theme.fg("dim", todo.content)}`
		}
		return ` ${index}.  ${theme.fg("accent", symbol)} ${theme.fg("accent", theme.bold(todo.activeForm ?? todo.content))}`
	}

	// Ferment step — dim the prefix arrow, normal for rest
	if (isFerment && todo.content.startsWith("↳ ")) {
		const arrow = "↳ "
		const text = todo.content.slice(arrow.length)
		if (todo.status === "completed") {
			return ` ${index}.  ${theme.fg("success", symbol)} ${theme.fg("dim", arrow)}${theme.fg("dim", text)}`
		}
		if (todo.status === "blocked") {
			return ` ${index}.  ${theme.fg("warning", symbol)} ${theme.fg("dim", arrow)}${theme.fg("warning", text)}`
		}
		if (todo.status === "in_progress") {
			return ` ${index}.  ${theme.fg("accent", symbol)} ${theme.fg("dim", arrow)}${theme.fg("accent", todo.activeForm ?? text)}`
		}
		return ` ${index}.  ${theme.fg("dim", symbol)} ${theme.fg("dim", arrow)}${text}`
	}

	// Global todos — original behavior
	if (todo.status === "completed") return ` ${index}.  ${theme.fg("success", symbol)} ${theme.fg("dim", todo.content)}`
	if (todo.status === "blocked")
		return ` ${index}.  ${theme.fg("warning", symbol)} ${theme.fg("warning", todo.content)}`
	if (todo.status === "in_progress") {
		return ` ${index}.  ${theme.fg("accent", symbol)} ${theme.fg("accent", todo.activeForm ?? todo.content)}`
	}
	return ` ${index}.  ${theme.fg("dim", symbol)} ${todo.content}`
}

function formatScopeHeader(scope: TodoScope): string {
	if (scope.kind === "ferment") {
		return `Todos · Ferment (${scope.phaseId})`
	}
	return "Todos · Global"
}

function summarizeTodosForScope(scope: TodoScope): string {
	return summarizeTodoCounts(getTodoCountsForScope(scope))
}

function selectTodoWindow(todos: TodoItem[]): {
	todos: TodoItem[]
	startIndex: number
	hiddenBefore: number
	hiddenAfter: number
} {
	const firstActiveIndex = todos.findIndex((todo) => todo.status !== "completed")
	const startIndex =
		firstActiveIndex === -1
			? Math.max(0, todos.length - TODO_WIDGET_ROLL_THRESHOLD)
			: firstActiveIndex >= TODO_WIDGET_ROLL_THRESHOLD
				? firstActiveIndex - MAX_ROLLED_CONTEXT_ROWS
				: 0
	const baseVisibleCount =
		startIndex > 0 && firstActiveIndex !== -1 ? MAX_ROLLED_CONTEXT_ROWS + MAX_ROLLED_TODO_ROWS : TODO_WIDGET_BODY_LINES
	const markerCount = (startIndex > 0 ? 1 : 0) + (todos.length > startIndex + baseVisibleCount ? 1 : 0)
	const visibleCount = Math.min(baseVisibleCount, TODO_WIDGET_BODY_LINES - markerCount)
	const visibleTodos = todos.slice(startIndex, startIndex + visibleCount)
	return {
		todos: visibleTodos,
		startIndex,
		hiddenBefore: startIndex,
		hiddenAfter: Math.max(0, todos.length - startIndex - visibleTodos.length),
	}
}

function todoWindowBeforeText(hiddenBefore: number): string | undefined {
	return hiddenBefore > 0 ? `… ${hiddenBefore} completed` : undefined
}

function todoWindowAfterText(hiddenAfter: number): string | undefined {
	return hiddenAfter > 0 ? `… ${hiddenAfter} more` : undefined
}

export function buildTodoLines(theme: Theme): string[] {
	const scope = resolveTodoScope()
	const todos = getTodosForScope(scope)

	if (todos.length === 0) {
		return [
			theme.fg("accent", formatScopeHeader(scope)),
			"",
			theme.fg("dim", "No todos yet. Add one with `/todos add <text>`."),
		]
	}

	const lines = buildTodoListHeaderLines(theme, scope)
	lines.push(...todos.map((todo, index) => todoLine(todo, index, theme, scope)))
	return lines
}

function buildTodoListHeaderLines(theme: Theme, scope: TodoScope): string[] {
	return [theme.fg("accent", formatScopeHeader(scope)), "", theme.fg("dim", summarizeTodosForScope(scope)), ""]
}

function buildTodoWidgetLines(theme: Theme, expanded: boolean): string[] {
	const scope = resolveTodoScope()
	const todos = getTodosForScope(scope)
	const lines = buildTodoLines(theme)
	const withHint = [...lines, "", theme.fg("dim", TODO_LIST_HINT_TEXT)]
	if (expanded) return withHint
	if (withHint.length <= MAX_TODO_WIDGET_LINES) return withHint
	if (todos.length <= TODO_WIDGET_ROLL_THRESHOLD) return lines

	const window = selectTodoWindow(todos)
	const beforeText = todoWindowBeforeText(window.hiddenBefore)
	const afterText = todoWindowAfterText(window.hiddenAfter)
	return [
		...buildTodoListHeaderLines(theme, scope),
		...(beforeText ? [theme.fg("dim", beforeText)] : []),
		...window.todos.map((todo, index) => todoLine(todo, window.startIndex + index, theme, scope)),
		...(afterText ? [theme.fg("dim", afterText)] : []),
	]
}

export function resetTodoWidgetState(): void {
	todoWidgetStates.clear()
	activeTodoWidgetSessionId = undefined
}

function requestTodoRender(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = todoWidgetStates.get(todoWidgetSessionId(ctx))
	if (!state?.registered) return
	state.tui?.requestRender?.(true)
}

export function setTodosStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const scope = resolveTodoScope()
	const counts = getTodoCountsForScope(scope)
	ctx.ui.setStatus(TODO_STATUS_KEY, hasActiveTodos(counts) ? `${summarizeTodoCounts(counts)} -> F7` : undefined)
}

export function ensureTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = todoWidgetSessionId(ctx)
	const state = getTodoWidgetState(ctx)
	if (state.registered && state.ctx === ctx) return

	const registrationId = state.registrationId + 1
	state.registrationId = registrationId
	const unregister = () => {
		if (state.registrationId !== registrationId) return
		state.registered = false
		state.tui = undefined
		state.ctx = undefined
		if (activeTodoWidgetSessionId === sessionId) activeTodoWidgetSessionId = undefined
	}
	const component = (tui: unknown, theme: Theme) => {
		state.tui = tui as { requestRender?: (force?: boolean) => void }
		return {
			render(width: number): string[] {
				if (!state.visible) return []
				return buildTodoWidgetLines(theme, state.expanded).map((line) => truncateToWidth(line, Math.max(20, width - 4)))
			},
			invalidate: unregister,
			dispose: unregister,
			handleInput(data: string): void {
				if (isKeyRelease(data)) return
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, "return") || data === "q") {
					collapseTodoWidget(ctx)
					return
				}
				if (matchesKey(data, TODO_SHORTCUT)) collapseTodoWidget(ctx)
			},
		}
	}
	ctx.ui.setWidget(TODO_WIDGET_KEY, component, TODO_WIDGET_OPTIONS)
	state.registered = true
	state.ctx = ctx
	activeTodoWidgetSessionId = sessionId
}

export function openTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = getTodoWidgetState(ctx)
	state.collapsed = false
	state.visible = true
	ensureTodoWidget(ctx)
	requestTodoRender(ctx)
	setTodosStatus(ctx)
}

export function expandTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = getTodoWidgetState(ctx)
	state.expanded = true
	openTodoWidget(ctx)
}

export function clearTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const state = getTodoWidgetState(ctx)
	state.visible = false
	state.expanded = false
	requestTodoRender(ctx)
}

export function collapseTodoWidget(ctx: ExtensionContext): void {
	getTodoWidgetState(ctx).collapsed = true
	clearTodoWidget(ctx)
	setTodosStatus(ctx)
}

export function toggleTodoWidget(ctx: ExtensionContext): void {
	if (getTodoWidgetState(ctx).visible) collapseTodoWidget(ctx)
	else openTodoWidget(ctx)
}

export function syncTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const scope = resolveTodoScope()
	const counts = getTodoCountsForScope(scope)
	const state = getTodoWidgetState(ctx)
	if (!state.collapsed && hasActiveTodos(counts)) openTodoWidget(ctx)
	else clearTodoWidget(ctx)
	setTodosStatus(ctx)
}

export function disposeTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = todoWidgetSessionId(ctx)
	const state = todoWidgetStates.get(sessionId)
	ctx.ui.setWidget(TODO_WIDGET_KEY, undefined, TODO_WIDGET_OPTIONS)
	if (state) {
		state.visible = false
		state.registered = false
		state.tui = undefined
		state.ctx = undefined
	}
	todoWidgetStates.delete(sessionId)
	if (activeTodoWidgetSessionId === sessionId) activeTodoWidgetSessionId = undefined
}

export function registerTodoShortcut(pi: ExtensionAPI): void {
	pi.registerShortcut(TODO_SHORTCUT, {
		description: "Toggle todos overlay",
		handler: (ctx) => toggleTodoWidget(ctx),
	})
}

export {
	buildTodoLines as __test_buildTodoLines,
	resetTodoWidgetState as __test_resetTodoWidgetState,
	summarizeTodos as __test_summarizeTodos,
}
