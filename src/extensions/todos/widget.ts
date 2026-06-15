import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { Key, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import { GLOBAL_TODO_SCOPE, getTodoCountsForScope, getTodosForScope } from "./store.js"
import type { TodoCounts, TodoItem, TodoStatus } from "./types.js"

export const TODO_SHORTCUT = Key.f7
export const TODO_SHORTCUT_HINT = "F7"

const TODO_WIDGET_KEY = "kimchi-todos"
const TODO_WIDGET_OPTIONS = { placement: "aboveEditor" } as const
const TODO_STATUS_KEY = "todos"
const TODO_LIST_HINT_TEXT = "F7 or enter '/todos' to collapse"
const MAX_TODO_WIDGET_LINES = 14
const TODO_SYMBOL: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "▶",
	blocked: "!",
	completed: "✓",
}

let visibleTodoWidget = false
let collapsedTodoWidget = false
let todoWidgetRegistered = false
let todoTui: { requestRender?: (force?: boolean) => void } | undefined

export function summarizeTodoCounts(counts: TodoCounts): string {
	if (counts.total === 0) return "No todos"
	const active = counts.pending + counts.inProgress + counts.blocked
	const blocked = counts.blocked > 0 ? ` · ${counts.blocked} blocked` : ""
	return `${counts.completed}/${counts.total} done · ${active} active${blocked}`
}

export function summarizeTodos(): string {
	return summarizeTodoCounts(getTodoCountsForScope(GLOBAL_TODO_SCOPE))
}

function todoLine(todo: TodoItem, displayIndex: number, theme: Theme): string {
	const index = `${displayIndex + 1}`.padStart(2)
	const symbol = TODO_SYMBOL[todo.status]
	if (todo.status === "completed") return ` ${index}.  ${theme.fg("success", symbol)} ${theme.fg("dim", todo.content)}`
	if (todo.status === "blocked")
		return ` ${index}.  ${theme.fg("warning", symbol)} ${theme.fg("warning", todo.content)}`
	if (todo.status === "in_progress") {
		return ` ${index}.  ${theme.fg("accent", symbol)} ${theme.fg("accent", todo.activeForm ?? todo.content)}`
	}
	return ` ${index}.  ${theme.fg("dim", symbol)} ${todo.content}`
}

export function buildTodoLines(theme: Theme): string[] {
	const todos = getTodosForScope(GLOBAL_TODO_SCOPE)
	const lines: string[] = [theme.fg("accent", "Todos · Global"), ""]

	if (todos.length === 0) {
		lines.push(theme.fg("dim", "No todos yet. Add one with `/todos add <text>`."))
		return lines
	}

	lines.push(theme.fg("dim", summarizeTodos()))
	lines.push("")
	lines.push(...todos.map((todo, index) => todoLine(todo, index, theme)))
	return lines
}

export function resetTodoWidgetState(): void {
	visibleTodoWidget = false
	collapsedTodoWidget = false
	todoWidgetRegistered = false
	todoTui = undefined
}

function requestTodoRender(ctx: ExtensionContext): void {
	if (!ctx.hasUI || !todoWidgetRegistered) return
	todoTui?.requestRender?.(true)
}

export function setTodosStatus(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const counts = getTodoCountsForScope(GLOBAL_TODO_SCOPE)
	ctx.ui.setStatus(TODO_STATUS_KEY, counts.total === 0 ? undefined : `${counts.completed}/${counts.total} todos -> F7`)
}

export function ensureTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI || todoWidgetRegistered) return
	const component = (tui: unknown, theme: Theme) => {
		todoTui = tui as { requestRender?: (force?: boolean) => void }
		return {
			render(width: number): string[] {
				if (!visibleTodoWidget) return []
				const lines = buildTodoLines(theme)
				const withHint = [...lines, "", theme.fg("dim", TODO_LIST_HINT_TEXT)]
				const visibleLines =
					withHint.length > MAX_TODO_WIDGET_LINES
						? [
								...withHint.slice(0, MAX_TODO_WIDGET_LINES - 1),
								theme.fg("dim", `… ${withHint.length - MAX_TODO_WIDGET_LINES + 1} more`),
							]
						: withHint
				return visibleLines.map((line) => truncateToWidth(line, Math.max(20, width - 4)))
			},
			invalidate() {
				todoWidgetRegistered = false
				todoTui = undefined
			},
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
	todoWidgetRegistered = true
}

export function openTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	collapsedTodoWidget = false
	visibleTodoWidget = true
	ensureTodoWidget(ctx)
	requestTodoRender(ctx)
	setTodosStatus(ctx)
}

export function clearTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	visibleTodoWidget = false
	requestTodoRender(ctx)
}

export function collapseTodoWidget(ctx: ExtensionContext): void {
	collapsedTodoWidget = true
	clearTodoWidget(ctx)
	setTodosStatus(ctx)
}

export function toggleTodoWidget(ctx: ExtensionContext): void {
	if (visibleTodoWidget) collapseTodoWidget(ctx)
	else openTodoWidget(ctx)
}

export function syncTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	const counts = getTodoCountsForScope(GLOBAL_TODO_SCOPE)
	if (!collapsedTodoWidget && counts.total > 0) openTodoWidget(ctx)
	else clearTodoWidget(ctx)
	setTodosStatus(ctx)
}

export function disposeTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	ctx.ui.setWidget(TODO_WIDGET_KEY, undefined, TODO_WIDGET_OPTIONS)
	visibleTodoWidget = false
	todoWidgetRegistered = false
	todoTui = undefined
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
