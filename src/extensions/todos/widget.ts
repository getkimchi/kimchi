import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import { parseTodoScopeKey } from "./scope.js"
import { GLOBAL_TODO_SCOPE, getTodoCountsForScope, getTodoState, resolveTodoScope } from "./store.js"
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

function createTodoWidgetState(): TodoWidgetState {
	return { visible: false, expanded: false, collapsed: false, registered: false, registrationId: 0 }
}

function getTodoWidgetState(ctx: ExtensionContext): TodoWidgetState {
	const sessionId = ctx.sessionManager.getSessionId()
	let state = todoWidgetStates.get(sessionId)
	if (!state) {
		state = createTodoWidgetState()
		todoWidgetStates.set(sessionId, state)
	}
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

export function summarizeTodos(sessionId: string): string {
	return summarizeTodoCounts(getTodoCountsForScope(GLOBAL_TODO_SCOPE, sessionId))
}

/** Render a single todo line. Uses a per-scope sequential position (not the
 *  stored todo id) so numbers restart at 1 within each scope group. Styling is
 *  determined by `scope.kind` (not content prefixes) so a model-written global
 *  item that starts with "[Phase " gets normal global styling. */
function todoLine(todo: TodoItem, displayIndex: number, theme: Theme, scope: TodoScope): string {
	const index = `${displayIndex + 1}`.padStart(2)
	const symbol = TODO_SYMBOL[todo.status]
	const isFerment = scope.kind === "ferment"

	// Phase header — bold accent (bridge-written: "[Phase N] Name")
	if (isFerment && todo.content.startsWith("[Phase ")) {
		if (todo.status === "completed") {
			return ` ${index}.  ${theme.fg("success", symbol)} ${theme.fg("dim", todo.content)}`
		}
		return ` ${index}.  ${theme.fg("accent", symbol)} ${theme.fg("accent", theme.bold(todo.activeForm ?? todo.content))}`
	}

	// Ferment step item — dim the prefix arrow (bridge-written: "↳ description")
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

	// All other todos (global, ferment-step sub-tasks) — standard rendering
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
	if (scope.kind === "ferment-step") {
		return `Todos · Step (${scope.phaseId}/${scope.stepId})`
	}
	return "Todos · Global"
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

/** Collect all non-empty scopes from the store, grouped by kind.
 *  Returns ferment scopes first (sorted by phaseId), then step scopes,
 *  then global. This lets the widget show the full ferment hierarchy
 *  (phase header + steps, step sub-tasks, global todos) in one view. */
interface WidgetScopeGroup {
	scope: TodoScope
	todos: TodoItem[]
}

function collectWidgetScopes(sessionId: string): WidgetScopeGroup[] {
	const state = getTodoState(sessionId)
	const scopeKeys = Object.keys(state.byScope)
	if (scopeKeys.length === 0) return []

	const fermentScopes: WidgetScopeGroup[] = []
	const stepScopes: WidgetScopeGroup[] = []
	let globalGroup: WidgetScopeGroup | undefined

	for (const scopeKey of scopeKeys) {
		let scope: TodoScope | undefined
		try {
			scope = parseTodoScopeKey(scopeKey)
		} catch {
			continue
		}
		const scopeState = state.byScope[scopeKey]
		if (!scopeState || scopeState.todos.length === 0) continue

		const todos = [...scopeState.todos].sort((a, b) => a.id - b.id)

		if (scope.kind === "global") {
			globalGroup = { scope, todos }
			continue
		}

		if (scope.kind === "ferment") {
			fermentScopes.push({ scope, todos })
			continue
		}

		if (scope.kind === "ferment-step") {
			stepScopes.push({ scope, todos })
		}
	}

	// Sort ferment scopes by phaseId for stable ordering
	fermentScopes.sort((a, b) => {
		const pa = (a.scope as { phaseId: string }).phaseId
		const pb = (b.scope as { phaseId: string }).phaseId
		return pa < pb ? -1 : pa > pb ? 1 : 0
	})
	stepScopes.sort((a, b) => {
		const pa = a.scope as { phaseId: string; stepId: string }
		const pb = b.scope as { phaseId: string; stepId: string }
		if (pa.phaseId !== pb.phaseId) return pa.phaseId < pb.phaseId ? -1 : 1
		return pa.stepId < pb.stepId ? -1 : pa.stepId > pb.stepId ? 1 : 0
	})

	return [...fermentScopes, ...stepScopes, ...(globalGroup ? [globalGroup] : [])]
}

/** Count active todos across all scopes for the status bar. */
function countAllActiveTodos(sessionId: string): TodoCounts {
	const groups = collectWidgetScopes(sessionId)
	const allTodos = groups.flatMap((g) => g.todos)
	return {
		total: allTodos.length,
		completed: allTodos.filter((t) => t.status === "completed").length,
		pending: allTodos.filter((t) => t.status === "pending").length,
		blocked: allTodos.filter((t) => t.status === "blocked").length,
		inProgress: allTodos.filter((t) => t.status === "in_progress").length,
	}
}

export function buildTodoLines(theme: Theme, sessionId: string): string[] {
	const groups = collectWidgetScopes(sessionId)

	if (groups.length === 0) {
		const scope = resolveTodoScope()
		return [
			theme.fg("accent", formatScopeHeader(scope)),
			"",
			theme.fg("dim", "No todos yet. Add one with `/todos add <text>`."),
		]
	}

	const lines: string[] = []

	for (const group of groups) {
		const summary = summarizeTodoCounts(getTodoCountsForScope(group.scope, sessionId))
		lines.push(theme.fg("accent", formatScopeHeader(group.scope)))
		lines.push("")
		lines.push(theme.fg("dim", summary))
		lines.push("")
		let groupIndex = 0
		for (const todo of group.todos) {
			lines.push(todoLine(todo, groupIndex, theme, group.scope))
			groupIndex++
		}
		lines.push("")
	}

	// Trim trailing blank line
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
	return lines
}

function buildTodoWidgetLines(theme: Theme, expanded: boolean, sessionId: string): string[] {
	const groups = collectWidgetScopes(sessionId)

	// For the capped (non-expanded) view, collect all todos across scopes
	// and apply the rolling window to the combined list.
	const allTodos = groups.flatMap((g) => g.todos)
	const lines = buildTodoLines(theme, sessionId)
	const withHint = [...lines, "", theme.fg("dim", TODO_LIST_HINT_TEXT)]
	if (expanded) return withHint
	if (withHint.length <= MAX_TODO_WIDGET_LINES) return withHint
	if (allTodos.length <= TODO_WIDGET_ROLL_THRESHOLD) return lines

	const window = selectTodoWindow(allTodos)
	const beforeText = todoWindowBeforeText(window.hiddenBefore)
	const afterText = todoWindowAfterText(window.hiddenAfter)

	// Single pass: for each group, if it contributes ≥1 windowed row, emit
	// header + summary immediately followed by that group's windowed rows.
	// Groups with zero windowed rows are skipped entirely (no orphan headers).
	const result: string[] = []
	let displayIndex = 0
	let beforeInserted = false

	for (const group of groups) {
		const groupTodos = group.todos
		const groupStartIndex = displayIndex
		const groupEndIndex = displayIndex + groupTodos.length

		// Skip groups entirely outside the window
		if (groupEndIndex <= window.hiddenBefore || groupStartIndex >= window.hiddenBefore + window.todos.length) {
			displayIndex = groupEndIndex
			continue
		}

		// Emit header + summary for this group
		result.push(theme.fg("accent", formatScopeHeader(group.scope)))
		result.push("")
		result.push(theme.fg("dim", summarizeTodoCounts(getTodoCountsForScope(group.scope, sessionId))))
		result.push("")

		// Emit windowed rows for this group, inserting before-marker before the first visible row
		let groupDisplayIndex = 0
		for (const todo of groupTodos) {
			if (displayIndex >= window.hiddenBefore && displayIndex < window.hiddenBefore + window.todos.length) {
				if (beforeText && !beforeInserted) {
					result.push(theme.fg("dim", beforeText))
					beforeInserted = true
				}
				result.push(todoLine(todo, groupDisplayIndex, theme, group.scope))
			}
			displayIndex++
			groupDisplayIndex++
		}
		result.push("")
	}

	// Emit after-marker after the last visible row
	if (afterText) {
		while (result.length > 0 && result[result.length - 1] === "") result.pop()
		result.push(theme.fg("dim", afterText))
	}

	return result
}

export function resetTodoWidgetState(ctx: ExtensionContext): void {
	const sessionId = ctx.sessionManager.getSessionId()
	todoWidgetStates.delete(sessionId)
}

function requestTodoRender(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = ctx.sessionManager.getSessionId()
	const state = todoWidgetStates.get(sessionId)
	if (!state?.registered) return
	state.tui?.requestRender?.(true)
}

export function setTodosStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = ctx.sessionManager.getSessionId()
	const counts = countAllActiveTodos(sessionId)
	ctx.ui.setStatus(TODO_STATUS_KEY, hasActiveTodos(counts) ? `${summarizeTodoCounts(counts)} -> F7` : undefined)
}

export function ensureTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = ctx.sessionManager.getSessionId()
	const state = getTodoWidgetState(ctx)
	if (state.registered && state.ctx === ctx) return

	const registrationId = state.registrationId + 1
	state.registrationId = registrationId
	const unregister = () => {
		if (state.registrationId !== registrationId) return
		state.registered = false
		state.tui = undefined
		state.ctx = undefined
	}
	const component = (tui: unknown, theme: Theme) => {
		state.tui = tui as { requestRender?: (force?: boolean) => void }
		return {
			render(width: number): string[] {
				if (!state.visible) return []
				return buildTodoWidgetLines(theme, state.expanded, sessionId).map((line) =>
					truncateToWidth(line, Math.max(1, width - 4)),
				)
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
	const sessionId = ctx.sessionManager.getSessionId()
	const counts = countAllActiveTodos(sessionId)
	const state = getTodoWidgetState(ctx)
	if (!state.collapsed && hasActiveTodos(counts)) openTodoWidget(ctx)
	else clearTodoWidget(ctx)
	setTodosStatus(ctx)
}

export function disposeTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const sessionId = ctx.sessionManager.getSessionId()
	const state = todoWidgetStates.get(sessionId)
	ctx.ui.setWidget(TODO_WIDGET_KEY, undefined, TODO_WIDGET_OPTIONS)
	if (state) {
		state.visible = false
		state.registered = false
		state.tui = undefined
		state.ctx = undefined
	}
	todoWidgetStates.delete(sessionId)
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
