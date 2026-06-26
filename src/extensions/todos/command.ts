import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { applyWriteTodos, getTodosForScope } from "./store.js"
import type { TodoStatus, WriteTodosDetails, WriteTodosParams } from "./types.js"
import {
	buildTodoLines,
	collapseTodoWidget,
	expandTodoWidget,
	openTodoWidget,
	syncTodoWidget,
	toggleTodoWidget,
} from "./widget.js"

export const TODOS_COMMAND = "todos"

type TodoAction =
	| "help"
	| "list"
	| "add"
	| "done"
	| "pending"
	| "start"
	| "block"
	| "toggle"
	| "delete"
	| "clear"
	| "open"
	| "expand"
	| "expand_all"
	| "collapse"

interface TodoUiLine {
	action: TodoAction
	text: string
	index: number | null
}

const COMMAND_COMPLETIONS = [
	"add",
	"done",
	"pending",
	"undone",
	"start",
	"block",
	"toggle",
	"rm",
	"remove",
	"list",
	"expand",
	"expand all",
	"show all",
	"all",
	"collapse",
	"clear",
	"help",
]

function parseTodoIndex(text: string): number | null {
	const index = Number.parseInt(text.trim(), 10)
	if (!Number.isInteger(index) || index <= 0) return null
	return index - 1
}

function parseIndexedAction(
	trimmed: string,
	normalized: string,
	prefix: string,
	action: TodoAction,
): TodoUiLine | undefined {
	if (!normalized.startsWith(`${prefix} `)) return undefined
	const index = parseTodoIndex(trimmed.slice(prefix.length + 1))
	return index === null ? { action: "help", text: trimmed, index: null } : { action, text: "", index }
}

function parseTodoArgs(args: string): TodoUiLine {
	const trimmed = args.trim()
	if (!trimmed) return { action: "open", text: "", index: null }
	const normalized = trimmed.toLowerCase()

	if (normalized === "list" || normalized === "ls") return { action: "list", text: "", index: null }
	if (normalized === "all" || normalized === "expand all" || normalized === "show all") {
		return { action: "expand_all", text: "", index: null }
	}
	if (normalized === "open" || normalized === "show" || normalized === "expand") {
		return { action: "expand", text: "", index: null }
	}
	if (normalized === "close" || normalized === "hide" || normalized === "collapse") {
		return { action: "collapse", text: "", index: null }
	}
	if (normalized === "clear") return { action: "clear", text: "", index: null }
	if (normalized === "help") return { action: "help", text: trimmed, index: null }
	if (normalized.startsWith("add ")) return { action: "add", text: trimmed.slice(4).trim(), index: null }

	for (const [prefix, action] of [
		["done", "done"],
		["pending", "pending"],
		["undone", "pending"],
		["start", "start"],
		["block", "block"],
		["toggle", "toggle"],
		["rm", "delete"],
		["remove", "delete"],
	] as const) {
		const parsed = parseIndexedAction(trimmed, normalized, prefix, action)
		if (parsed) return parsed
	}

	return { action: "help", text: trimmed, index: null }
}

function notifyUsage(theme: Theme): string[] {
	return [
		theme.fg("warning", "Todo usage:"),
		`  /${TODOS_COMMAND}                    Toggle todo overlay`,
		`  /${TODOS_COMMAND} expand             Expand todo overlay`,
		`  /${TODOS_COMMAND} expand all         Expand todo overlay without capping`,
		`  /${TODOS_COMMAND} collapse           Collapse todo overlay`,
		`  /${TODOS_COMMAND} add <text>          Add a todo item`,
		`  /${TODOS_COMMAND} done <n>            Mark an item completed`,
		`  /${TODOS_COMMAND} pending <n>         Mark an item pending`,
		`  /${TODOS_COMMAND} start <n>           Mark an item in progress`,
		`  /${TODOS_COMMAND} block <n>           Mark an item blocked`,
		`  /${TODOS_COMMAND} rm <n>              Remove an item`,
		`  /${TODOS_COMMAND} clear              Clear global todos`,
	]
}

function targetStatus(action: TodoAction, currentStatus: TodoStatus): TodoStatus | undefined {
	if (action === "done") return "completed"
	if (action === "pending") return "pending"
	if (action === "start") return "in_progress"
	if (action === "block") return "blocked"
	if (action === "toggle") return currentStatus === "completed" ? "pending" : "completed"
	return undefined
}

interface ApplyTodoActionOptions {
	onWrite?: (details: WriteTodosDetails) => void
}

function writeTodos(params: WriteTodosParams, options: ApplyTodoActionOptions): WriteTodosDetails {
	const details = applyWriteTodos(params)
	options.onWrite?.(details)
	return details
}

function applyTodoAction(
	parsed: TodoUiLine,
	options: ApplyTodoActionOptions = {},
): { message: string; level: "info" | "error" } | null {
	const todos = getTodosForScope()

	if (parsed.action === "add") {
		const content = parsed.text.trim().replace(/\s+/g, " ")
		if (!content) return { message: "No todo text provided. Use '/todos add <text>'.", level: "error" }
		writeTodos({ todos: [...todos, { content, status: "pending" }] }, options)
		return { message: `Added todo: ${content}`, level: "info" }
	}

	if (parsed.action === "clear") {
		writeTodos({ todos: [] }, options)
		return { message: "Cleared global todos.", level: "info" }
	}

	if (
		parsed.action === "help" ||
		parsed.action === "open" ||
		parsed.action === "expand" ||
		parsed.action === "collapse" ||
		parsed.action === "list"
	) {
		return null
	}

	if (parsed.index === null || parsed.index < 0 || parsed.index >= todos.length) {
		return {
			message: `Usage: /${TODOS_COMMAND} ${parsed.action === "delete" ? "rm" : parsed.action} <index>`,
			level: "error",
		}
	}

	const current = todos[parsed.index]
	if (!current) return { message: "Invalid todo index.", level: "error" }

	const next = [...todos]
	if (parsed.action === "delete") {
		next.splice(parsed.index, 1)
	} else {
		const status = targetStatus(parsed.action, current.status)
		if (!status) return null
		next[parsed.index] = { ...current, status }
	}

	writeTodos({ todos: next }, options)
	return { message: `Updated todo ${parsed.index + 1}.`, level: "info" }
}

function plainTheme(): Theme {
	return { fg: (_color: string, text: string) => text } as Theme
}

async function handleTodosCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const parsed = parseTodoArgs(args)

	if (parsed.action === "open") {
		toggleTodoWidget(ctx)
		return
	}
	if (parsed.action === "expand") {
		openTodoWidget(ctx)
		return
	}
	if (parsed.action === "expand_all") {
		expandTodoWidget(ctx)
		return
	}
	if (parsed.action === "collapse") {
		collapseTodoWidget(ctx)
		return
	}
	if (parsed.action === "list") {
		const lines = ctx.hasUI
			? buildTodoLines(ctx.ui.theme)
			: getTodosForScope().map((todo, index) => `${index + 1}. [${todo.status}] ${todo.content}`)
		if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info")
		else console.log(lines.join("\n"))
		return
	}
	if (parsed.action === "help") {
		const lines = notifyUsage(ctx.hasUI ? ctx.ui.theme : plainTheme())
		if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info")
		else console.log(lines.join("\n"))
		return
	}

	const outcome = applyTodoAction(parsed, {
		onWrite: (details) => pi.appendEntry(TODO_CUSTOM_ENTRY_TYPE, details),
	})
	if (outcome) {
		if (ctx.hasUI) ctx.ui.notify(outcome.message, outcome.level)
		else console.log(outcome.message)
	}
	syncTodoWidget(ctx)
}

export function registerTodosCommand(pi: ExtensionAPI): void {
	const registerCommand = (name: string) => {
		pi.registerCommand(name, {
			description: "Open or edit tactical todos",
			getArgumentCompletions: (prefix) =>
				COMMAND_COMPLETIONS.filter((entry) => entry.startsWith(prefix.toLowerCase())).map((value) => ({
					value,
					label: value,
					description: `/${TODOS_COMMAND} ${value}`,
				})),
			handler: (args, ctx) => handleTodosCommand(args, ctx, pi),
		})
	}
	registerCommand(TODOS_COMMAND)
}

export {
	applyTodoAction as __test_applyTodoAction,
	parseTodoArgs as __test_parseTodoArgs,
	parseTodoIndex as __test_parseTodoIndex,
}
