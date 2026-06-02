import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent"
import { Key, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { isAgentWorker } from "../agent-worker-context.js"
import { type FermentRuntime, defaultFermentRuntime } from "../ferment/runtime.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import {
	type TodoScope,
	type TodoScopeFerment,
	type TodoScopeFermentPhase,
	type TodoScopeFermentStep,
	getTodoScopeKey,
	parseTodoScopeKey,
} from "./scope.js"
import { getActiveFermentStepScope } from "./selectors.js"
import {
	GLOBAL_TODO_SCOPE,
	applyWriteTodos,
	clearTodoStore,
	getAgentTodoBoards,
	getTodoCountsForScope,
	getTodosForScope,
	hydrateFermentTodos,
	resolveTodoDisplayScope,
	resolveTodoScope,
	setActiveFermentTodoScopeProvider,
} from "./store.js"
import type { AgentTodoBoard, TodoCounts, TodoItem, TodoStatus, WriteTodosParams } from "./types.js"

export * from "./types.js"
export * from "./scope.js"
export * from "./reducer.js"
export * from "./selectors.js"
export * from "./store.js"

const TODOS_COMMAND = "todos"
const TODO_TOOL_NAME = "write_todos"
const TODO_WIDGET_KEY = "kimchi-todos"
const TODO_WIDGET_OPTIONS = { placement: "aboveEditor" } as const
const TODO_STATUS_KEY = "todos"
const TODO_LIST_HINT_TEXT = "Esc/q/Enter/F7 to collapse"
const TODO_SHORTCUT = Key.f7
const TODO_SHORTCUT_HINT = "F7"
const MAX_TODO_WIDGET_LINES = 14
const MAX_AGENT_TODO_BOARDS = 3
const MAX_AGENT_TODOS_PER_BOARD = 2
const FERMENT_SCOPE_CHANGE_TOOLS = new Set([
	"propose_ferment_scoping",
	"scope_ferment",
	"activate_ferment_phase",
	"start_ferment_step",
	"complete_ferment_step",
	"skip_ferment_step",
	"fail_ferment_step",
])

const TODO_SYMBOL: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "▶",
	blocked: "!",
	completed: "✓",
}

interface TodoUiLine {
	action: TodoAction
	text: string
	index: number | null
}

type TodoAction =
	| "help"
	| "list"
	| "add"
	| "done"
	| "undone"
	| "toggle"
	| "delete"
	| "clear"
	| "open"
	| "expand"
	| "collapse"

const collapsedTodoScopeKeys = new Set<string>()
let visibleTodoScopeKey: string | undefined
let todoWidgetRegistered = false
let todoTui: { requestRender?: (force?: boolean) => void } | undefined

function isTodoDone(status: TodoStatus): boolean {
	return status === "completed"
}

function scopeLabel(scope: TodoScope): string {
	if (scope.kind === "global") return "Global"
	if (scope.kind === "agent") return `Agent · ${scope.agentId}`
	if (scope.kind === "ferment") return `Ferment · ${scope.fermentId}`
	if (scope.kind === "ferment_phase") return `Ferment · ${scope.phaseId}`
	return `Ferment · ${scope.phaseId}/${scope.stepId}`
}

function summarizeTodos(scope: TodoScope): string {
	const counts = getTodoCountsForScope(scope)
	return summarizeTodoCounts(counts)
}

function summarizeTodoCounts(counts: TodoCounts): string {
	if (counts.total === 0) return "No todos"
	const active = counts.pending + counts.inProgress + counts.blocked
	const blocked = counts.blocked > 0 ? ` · ${counts.blocked} blocked` : ""
	return `${counts.completed}/${counts.total} done · ${active} active${blocked}`
}

function resetTodoWidgetState(): void {
	collapsedTodoScopeKeys.clear()
	visibleTodoScopeKey = undefined
	todoWidgetRegistered = false
	todoTui = undefined
}

function statusNoun(scope: TodoScope): string {
	return scope.kind === "global" ? "todos" : "tactical"
}

function parseTodoIndex(text: string): number | null {
	const index = Number.parseInt(text.trim(), 10)
	if (!Number.isInteger(index) || index <= 0) return null
	return index - 1
}

function parseTodoArgs(args: string): TodoUiLine {
	const trimmed = args.trim()
	if (!trimmed) return { action: "open", text: "", index: null }
	const normalized = trimmed.toLowerCase()
	if (normalized === "list" || normalized === "ls") return { action: "list", text: "", index: null }
	if (normalized === "open" || normalized === "show" || normalized === "expand")
		return { action: "expand", text: "", index: null }
	if (normalized === "close" || normalized === "hide" || normalized === "collapse")
		return { action: "collapse", text: "", index: null }
	if (normalized === "clear") return { action: "clear", text: "", index: null }
	if (normalized === "help") return { action: "help", text: trimmed, index: null }
	if (normalized.startsWith("add ")) return { action: "add", text: trimmed.slice(4).trim(), index: null }
	if (normalized.startsWith("done ")) {
		const index = parseTodoIndex(trimmed.slice(5))
		return index === null ? { action: "help", text: trimmed, index: null } : { action: "done", text: "", index }
	}
	if (normalized.startsWith("undone ")) {
		const index = parseTodoIndex(trimmed.slice(7))
		return index === null ? { action: "help", text: trimmed, index: null } : { action: "undone", text: "", index }
	}
	if (normalized.startsWith("toggle ")) {
		const index = parseTodoIndex(trimmed.slice(7))
		return index === null ? { action: "help", text: trimmed, index: null } : { action: "toggle", text: "", index }
	}
	if (normalized.startsWith("rm ") || normalized.startsWith("remove ")) {
		const source = normalized.startsWith("rm ") ? trimmed.slice(3) : trimmed.slice(7)
		const index = parseTodoIndex(source)
		return index === null ? { action: "help", text: trimmed, index: null } : { action: "delete", text: "", index }
	}
	return { action: "help", text: trimmed, index: null }
}

function todoLine(todo: TodoItem, displayIndex: number, theme: Theme): string {
	const index = `${displayIndex + 1}`.padStart(2)
	const symbol = TODO_SYMBOL[todo.status]
	if (todo.status === "completed") return ` ${index}.  ${theme.fg("success", symbol)} ${theme.fg("dim", todo.content)}`
	if (todo.status === "blocked")
		return ` ${index}.  ${theme.fg("warning", symbol)} ${theme.fg("warning", todo.content)}`
	if (todo.status === "in_progress")
		return ` ${index}.  ${theme.fg("accent", symbol)} ${theme.fg("accent", todo.activeForm ?? todo.content)}`
	return ` ${index}.  ${theme.fg("dim", symbol)} ${todo.content}`
}

function fermentTodoLine(todo: TodoItem, displayIndex: number, theme: Theme): string {
	const index = `${displayIndex + 1}`.padStart(2)
	const symbol = TODO_SYMBOL[todo.status]
	if (todo.status === "completed") {
		return ` ${index}.  ${theme.fg("success", symbol)} ${theme.fg("dim", "done    ")} ${theme.fg("dim", todo.content)}`
	}
	if (todo.status === "blocked") {
		return ` ${index}.  ${theme.fg("warning", symbol)} ${theme.fg("warning", "blocked ")} ${theme.fg("warning", todo.content)}`
	}
	if (todo.status === "in_progress") {
		return ` ${index}.  ${theme.fg("accent", symbol)} ${theme.fg("accent", "now     ")} ${theme.fg("accent", todo.activeForm ?? todo.content)}`
	}
	return ` ${index}.  ${theme.fg("dim", symbol)} ${theme.fg("dim", "next    ")} ${todo.content}`
}

function sortedTodosForDisplay(todos: readonly TodoItem[]): TodoItem[] {
	const order: Record<TodoStatus, number> = { in_progress: 0, blocked: 1, pending: 2, completed: 3 }
	return [...todos].sort((a, b) => order[a.status] - order[b.status] || a.id - b.id)
}

export function buildTodoLines(theme: Theme, scope: TodoScope = resolveTodoScope()): string[] {
	const todos = sortedTodosForDisplay(getTodosForScope(scope))
	const agentBoards = scope.kind === "agent" ? [] : getAgentTodoBoards()
	const appendAgentBoards = (lines: string[]) => appendAgentTodoLines(lines, theme, agentBoards)
	if (scope.kind === "ferment" || scope.kind === "ferment_phase" || scope.kind === "ferment_step") {
		return appendAgentBoards(buildFermentTodoLines(theme, scope, todos))
	}

	const lines: string[] = [theme.fg("accent", `Todos · ${scopeLabel(scope)}`), ""]
	if (todos.length === 0) {
		lines.push(theme.fg("dim", "No todos yet. Add one with `/todos add <text>`."))
		return appendAgentBoards(lines)
	}
	lines.push(theme.fg("dim", summarizeTodos(scope)))
	lines.push("")
	const rows = todos.map((todo, index) => todoLine(todo, index, theme))
	lines.push(...rows)
	return appendAgentBoards(lines)
}

function appendAgentTodoLines(lines: string[], theme: Theme, boards: readonly AgentTodoBoard[]): string[] {
	if (boards.length === 0) return lines

	const next = [...lines, "", theme.fg("accent", "Subagent work")]
	for (const board of boards.slice(0, MAX_AGENT_TODO_BOARDS)) {
		next.push(theme.fg("dim", `${board.label} · ${summarizeTodoCounts(board.counts)}`))
		const todos = sortedTodosForDisplay(board.todos)
		for (const todo of todos.slice(0, MAX_AGENT_TODOS_PER_BOARD)) {
			const symbol = TODO_SYMBOL[todo.status]
			const content = todo.activeForm ?? todo.content
			next.push(`  ${theme.fg(todo.status === "blocked" ? "warning" : "dim", symbol)} ${content}`)
		}
		if (todos.length > MAX_AGENT_TODOS_PER_BOARD) {
			next.push(theme.fg("dim", `  +${todos.length - MAX_AGENT_TODOS_PER_BOARD} more`))
		}
	}
	if (boards.length > MAX_AGENT_TODO_BOARDS) {
		next.push(theme.fg("dim", `+${boards.length - MAX_AGENT_TODO_BOARDS} more subagents`))
	}
	return next
}

function fermentScopeLine(scope: TodoScopeFerment | TodoScopeFermentPhase | TodoScopeFermentStep): string {
	if (scope.kind === "ferment") return `Ferment ${scope.fermentId} · Scoping`
	if (scope.kind === "ferment_phase") return `Ferment ${scope.fermentId} · Phase ${scope.phaseId}`
	return `Ferment ${scope.fermentId} · Phase ${scope.phaseId} · Step ${scope.stepId}`
}

function buildFermentTodoLines(
	theme: Theme,
	scope: TodoScopeFerment | TodoScopeFermentPhase | TodoScopeFermentStep,
	todos: readonly TodoItem[],
): string[] {
	const lines: string[] = [theme.fg("accent", "Tactical work"), theme.fg("dim", fermentScopeLine(scope)), ""]
	if (todos.length === 0) {
		lines.push(theme.fg("dim", "No tactical work yet. Add one with `/todos add <text>`."))
		return lines
	}
	lines.push(theme.fg("dim", summarizeTodos(scope)))
	lines.push("")
	lines.push(...todos.map((todo, index) => fermentTodoLine(todo, index, theme)))
	return lines
}

function getVisibleTodoScope(): TodoScope | undefined {
	if (!visibleTodoScopeKey) return undefined
	try {
		return parseTodoScopeKey(visibleTodoScopeKey)
	} catch {
		return undefined
	}
}

function setTodosStatus(
	ctx: ExtensionContext,
	scope: TodoScope = getVisibleTodoScope() ?? resolveTodoDisplayScope(),
): void {
	if (!ctx.hasUI) return
	const counts = getTodoCountsForScope(scope)
	ctx.ui.setStatus(
		TODO_STATUS_KEY,
		counts.total === 0 ? undefined : `${counts.completed}/${counts.total} ${statusNoun(scope)} → ${TODO_SHORTCUT_HINT}`,
	)
}

function clearTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	visibleTodoScopeKey = undefined
	requestTodoRender(ctx)
}

function ensureTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI || todoWidgetRegistered) return
	const component = (tui: unknown, theme: Theme) => {
		todoTui = tui as { requestRender?: (force?: boolean) => void }
		return {
			render(width: number): string[] {
				if (!visibleTodoScopeKey) return []
				const lines = buildTodoLines(theme, getVisibleTodoScope() ?? resolveTodoDisplayScope())
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
				if (matchesKey(data, TODO_SHORTCUT)) {
					collapseTodoWidget(ctx)
				}
			},
		}
	}
	ctx.ui.setWidget(TODO_WIDGET_KEY, component, TODO_WIDGET_OPTIONS)
	todoWidgetRegistered = true
}

function requestTodoRender(ctx: ExtensionContext): void {
	if (!ctx.hasUI || !todoWidgetRegistered) return
	todoTui?.requestRender?.(true)
}

function disposeTodoWidget(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return
	ctx.ui.setWidget(TODO_WIDGET_KEY, undefined, TODO_WIDGET_OPTIONS)
	visibleTodoScopeKey = undefined
	todoWidgetRegistered = false
	todoTui = undefined
}

function openTodoWidget(ctx: ExtensionContext, scope: TodoScope = resolveTodoDisplayScope()): void {
	if (!ctx.hasUI) return
	const scopeKey = getTodoScopeKey(scope)
	collapsedTodoScopeKeys.delete(scopeKey)
	visibleTodoScopeKey = scopeKey
	ensureTodoWidget(ctx)
	requestTodoRender(ctx)
	setTodosStatus(ctx, scope)
}

function collapseTodoWidget(ctx: ExtensionContext): void {
	collapsedTodoScopeKeys.add(visibleTodoScopeKey ?? getTodoScopeKey(resolveTodoDisplayScope()))
	clearTodoWidget(ctx)
	setTodosStatus(ctx)
}

function toggleTodoWidget(ctx: ExtensionContext): void {
	if (visibleTodoScopeKey) collapseTodoWidget(ctx)
	else openTodoWidget(ctx)
}

function syncTodoWidget(ctx: ExtensionContext, preferredScope?: TodoScope): void {
	if (!ctx.hasUI) return
	const scope = preferredScope ?? getVisibleTodoScope() ?? resolveTodoDisplayScope()
	const scopeKey = getTodoScopeKey(scope)
	const counts = getTodoCountsForScope(scope)
	const hasAgentTodos = getAgentTodoBoards().length > 0
	if (!collapsedTodoScopeKeys.has(scopeKey) && (counts.total > 0 || hasAgentTodos)) openTodoWidget(ctx, scope)
	else clearTodoWidget(ctx)
	setTodosStatus(ctx, scope)
}

function seedActiveFermentStepTodo(runtime: Pick<FermentRuntime, "getActive">): void {
	const ferment = runtime.getActive()
	if (!ferment) return
	const scope = getActiveFermentStepScope(ferment)
	if (scope?.level !== "step" || !scope.phaseId || !scope.stepId) return

	const todoScope = {
		kind: "ferment_step" as const,
		fermentId: scope.fermentId,
		phaseId: scope.phaseId,
		stepId: scope.stepId,
	}
	if (getTodosForScope(todoScope).length > 0) return

	const phase = ferment.phases.find((candidate) => candidate.id === scope.phaseId)
	const step = phase?.steps.find((candidate) => candidate.id === scope.stepId)
	const content = step?.description?.trim() || phase?.goal?.trim() || phase?.name?.trim()
	if (!content) return

	applyWriteTodos({
		scope: todoScope,
		todos: [{ content, status: "in_progress" }],
	})
}

function notifyUsage(theme: Theme): string[] {
	return [
		theme.fg("warning", "Todo usage:"),
		`  /${TODOS_COMMAND}                    Toggle todo overlay`,
		`  /${TODOS_COMMAND} expand             Expand todo overlay`,
		`  /${TODOS_COMMAND} collapse           Collapse todo overlay`,
		`  /${TODOS_COMMAND} add <text>          Add a todo item`,
		`  /${TODOS_COMMAND} done <n>            Mark an item completed`,
		`  /${TODOS_COMMAND} undone <n>          Re-open a completed item`,
		`  /${TODOS_COMMAND} toggle <n>          Toggle pending/completed`,
		`  /${TODOS_COMMAND} rm <n>              Remove an item`,
		`  /${TODOS_COMMAND} clear              Clear current-scope todos`,
	]
}

function applyTodoAction(parsed: TodoUiLine): { message: string; level: "info" | "error" } | null {
	const scope = resolveTodoScope()
	const todos = getTodosForScope(scope)
	if (parsed.action === "add") {
		const content = parsed.text.trim().replace(/\s+/g, " ")
		if (!content) return { message: "No todo text provided. Use '/todos add <text>'.", level: "error" }
		applyWriteTodos({ scope, todos: [...todos, { content, status: "pending" }] })
		return { message: `Added todo: ${content}`, level: "info" }
	}
	if (parsed.action === "clear") {
		applyWriteTodos({ scope, todos: [] })
		return { message: "Cleared current-scope todos.", level: "info" }
	}
	if (
		parsed.action === "help" ||
		parsed.action === "open" ||
		parsed.action === "expand" ||
		parsed.action === "collapse" ||
		parsed.action === "list"
	)
		return null
	if (parsed.index === null || parsed.index < 0 || parsed.index >= todos.length) {
		return {
			message: `Usage: /${TODOS_COMMAND} ${parsed.action === "delete" ? "rm" : parsed.action} <index>`,
			level: "error",
		}
	}
	const current = todos[parsed.index]
	if (!current) return { message: "Invalid todo index.", level: "error" }
	const next = [...todos]
	if (parsed.action === "done") next[parsed.index] = { ...current, status: "completed" }
	if (parsed.action === "undone") next[parsed.index] = { ...current, status: "pending" }
	if (parsed.action === "toggle") {
		next[parsed.index] = { ...current, status: isTodoDone(current.status) ? "pending" : "completed" }
	}
	if (parsed.action === "delete") next.splice(parsed.index, 1)
	applyWriteTodos({ scope, todos: next })
	return { message: `Updated todo ${parsed.index + 1}.`, level: "info" }
}

export default function todosExtension(pi: ExtensionAPI, runtime: FermentRuntime = defaultFermentRuntime): void {
	if (!isAgentWorker()) {
		setActiveFermentTodoScopeProvider(() => {
			const ferment = runtime.getActive()
			return ferment ? getActiveFermentStepScope(ferment) : undefined
		})
	}

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "Write Todos",
		description:
			"Replace the todo list for the current scope. Use for multi-step work. Todos are execution detail, not plan edits.",
		promptSnippet: "Maintain a tactical todo list for multi-step work",
		parameters: Type.Object({
			scope: Type.Optional(
				Type.Union([
					Type.Object({ kind: Type.Literal("global") }),
					Type.Object({
						kind: Type.Literal("ferment"),
						fermentId: Type.String(),
					}),
					Type.Object({
						kind: Type.Literal("ferment_phase"),
						fermentId: Type.String(),
						phaseId: Type.String(),
					}),
					Type.Object({
						kind: Type.Literal("phase"),
						fermentId: Type.String(),
						phaseId: Type.String(),
					}),
					Type.Object({
						kind: Type.Literal("ferment_step"),
						fermentId: Type.String(),
						phaseId: Type.String(),
						stepId: Type.String(),
					}),
					Type.Object({
						kind: Type.Literal("step"),
						fermentId: Type.String(),
						phaseId: Type.String(),
						stepId: Type.String(),
					}),
				]),
			),
			todos: Type.Array(
				Type.Object({
					id: Type.Optional(Type.Number()),
					content: Type.String(),
					status: Type.Union([
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("blocked"),
						Type.Literal("completed"),
					]),
					activeForm: Type.Optional(Type.String()),
					note: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_toolCallId, params: WriteTodosParams, _signal, _onUpdate, ctx) {
			const details = applyWriteTodos(params)
			if (!isAgentWorker()) syncTodoWidget(ctx, details.scope)
			return {
				content: [
					{ type: "text" as const, text: `Updated ${details.todos.length} todos for ${scopeLabel(details.scope)}.` },
				],
				details,
			}
		},
	})

	if (isAgentWorker()) return

	pi.registerCommand(TODOS_COMMAND, {
		description: "Open or edit tactical todos",
		getArgumentCompletions: (prefix) =>
			["add", "done", "undone", "toggle", "rm", "remove", "list", "expand", "collapse", "clear", "help"]
				.filter((entry) => entry.startsWith(prefix.toLowerCase()))
				.map((value) => ({ value, label: value, description: `/${TODOS_COMMAND} ${value}` })),
		async handler(args, ctx) {
			const parsed = parseTodoArgs(args)
			if (parsed.action === "open") {
				toggleTodoWidget(ctx)
				return
			}
			if (parsed.action === "expand") {
				openTodoWidget(ctx)
				return
			}
			if (parsed.action === "collapse") {
				collapseTodoWidget(ctx)
				return
			}
			if (parsed.action === "list") {
				if (ctx.hasUI) ctx.ui.notify(buildTodoLines(ctx.ui.theme).join("\n"), "info")
				else
					console.log(
						getTodosForScope()
							.map((todo, index) => `${index + 1}. ${todo.content}`)
							.join("\n"),
					)
				return
			}
			if (parsed.action === "help") {
				if (ctx.hasUI) ctx.ui.notify(notifyUsage(ctx.ui.theme).join("\n"), "info")
				else console.log(notifyUsage({ fg: (_color: string, text: string) => text } as Theme).join("\n"))
				return
			}
			const outcome = applyTodoAction(parsed)
			if (outcome) {
				if (ctx.hasUI) ctx.ui.notify(outcome.message, outcome.level)
				else console.log(outcome.message)
			}
			syncTodoWidget(ctx)
		},
	})

	pi.registerShortcut(TODO_SHORTCUT, {
		description: "Toggle todos overlay",
		handler: (ctx) => toggleTodoWidget(ctx),
	})

	pi.on("session_start", (event, ctx) => {
		if (event.reason === "new") clearTodoStore()
		resetTodoWidgetState()
		const active = resolveTodoDisplayScope()
		if (active.kind === "ferment" || active.kind === "ferment_phase" || active.kind === "ferment_step") {
			hydrateFermentTodos(active.fermentId, ctx.cwd)
		}
		syncTodoWidget(ctx)
	})

	pi.on("tool_execution_end", (event, ctx) => {
		if (!event.isError && FERMENT_SCOPE_CHANGE_TOOLS.has(event.toolName)) {
			if (event.toolName === "start_ferment_step") seedActiveFermentStepTodo(runtime)
			syncTodoWidget(ctx, resolveTodoDisplayScope())
			return
		}
		if (!event.isError && (event.toolName === "Agent" || event.toolName === "get_subagent_result")) {
			syncTodoWidget(ctx)
		}
	})

	pi.on("session_shutdown", (_event, ctx) => {
		disposeTodoWidget(ctx)
		setActiveFermentTodoScopeProvider(undefined)
	})

	createSystemPromptBlocks(pi, "todos").register({
		id: "todo-guidance",
		render: () => renderTodoPromptBlock(runtime),
	})
}

function renderFermentTodoPromptBlock(runtime: Pick<FermentRuntime, "getActive">): string {
	const ferment = runtime.getActive()
	if (!ferment) return ""

	const scope = getActiveFermentStepScope(ferment)
	const scopeLine =
		scope?.level === "step" && scope.phaseId && scope.stepId
			? ` Current default todo scope is Ferment ${scope.fermentId}, phase ${scope.phaseId}, step ${scope.stepId}.`
			: scope?.level === "phase" && scope.phaseId
				? ` Current default todo scope is Ferment ${scope.fermentId}, phase ${scope.phaseId}.`
				: ` Current default todo scope is Ferment ${ferment.id}.`

	return `\n\nIn Ferment, use write_todos as the DeepAgent-style tactical board for the active step: decompose, execute, and adjust short-horizon sub-work while Ferment remains the source of truth for phases, steps, goals, success criteria, and evidence.${scopeLine} Omit the scope field to write to that current default scope. Keep Ferment tactical work anchored to the current phase/step and continue the visible in_progress item before pending items unless it is blocked. Do not use todos to rewrite Ferment scope or mark Ferment steps complete.`
}

function renderTodoPromptBlock(runtime: Pick<FermentRuntime, "getActive"> = defaultFermentRuntime): string {
	const scope = resolveTodoScope()
	const todos = getTodosForScope(scope)
	const current = todos.length
		? `\n\nCurrent ${scopeLabel(scope)} todos:\n${todos.map((todo) => `- #${todo.id} [${todo.status}] ${todo.content}`).join("\n")}`
		: ""
	return `## Todos\nUse write_todos for multi-step work. Do not use write_todos for a single straightforward or purely conversational task. Keep the list tactical and update it after meaningful progress. Keep at most one item in_progress when possible; when a current list is visible, continue the in_progress item before starting pending work. When updating an existing list, preserve user-created todos and existing ids unless the user asked to remove or rewrite them; append new todos after existing todos.${renderFermentTodoPromptBlock(runtime)}${current}`
}

export {
	applyTodoAction as __test_applyTodoAction,
	buildTodoLines as __test_buildTodoLines,
	parseTodoArgs as __test_parseTodoArgs,
	parseTodoIndex as __test_parseTodoIndex,
	renderFermentTodoPromptBlock as __test_renderFermentTodoPromptBlock,
	renderTodoPromptBlock as __test_renderTodoPromptBlock,
	resetTodoWidgetState as __test_resetTodoWidgetState,
	summarizeTodos as __test_summarizeTodos,
}
