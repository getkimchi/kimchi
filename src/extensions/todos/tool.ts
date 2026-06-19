import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { applyWriteTodos, getTodosForScope, resolveTodoScope } from "./store.js"
import { TODO_STATUSES, type TodoDraft, type TodoItem, type TodoStatus, type WriteTodosParams } from "./types.js"

export const UPDATE_TODOS_TOOL_NAME = "update_todos"
export const ADD_TODO_TOOL_NAME = "add_todo"
export const MARK_TODO_TOOL_NAME = "mark_todo"
export const CLEAR_TODOS_TOOL_NAME = "clear_todos"
export const TODO_TOOL_NAMES = [
	UPDATE_TODOS_TOOL_NAME,
	ADD_TODO_TOOL_NAME,
	MARK_TODO_TOOL_NAME,
	CLEAR_TODOS_TOOL_NAME,
] as const

const TODO_STATUS_PARAMETER = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("blocked"),
	Type.Literal("completed"),
])

const TODO_TOOL_PARAMETERS = Type.Object({
	scope: Type.Optional(Type.Any()),
	todos: Type.Array(
		Type.Object({
			id: Type.Optional(Type.Number()),
			content: Type.String(),
			status: TODO_STATUS_PARAMETER,
			activeForm: Type.Optional(Type.String()),
			note: Type.Optional(Type.String()),
		}),
	),
})

const ADD_TODO_PARAMETERS = Type.Object({
	scope: Type.Optional(Type.Any()),
	content: Type.String(),
	status: Type.Optional(TODO_STATUS_PARAMETER),
	activeForm: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
})

const MARK_TODO_PARAMETERS = Type.Object({
	scope: Type.Optional(Type.Any()),
	id: Type.Number(),
	status: TODO_STATUS_PARAMETER,
	activeForm: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
})

const CLEAR_TODOS_PARAMETERS = Type.Object({
	scope: Type.Optional(Type.Any()),
})

interface AddTodoParams {
	scope?: unknown
	content: string
	status?: TodoStatus
	activeForm?: string
	note?: string
}

interface MarkTodoParams {
	scope?: unknown
	id: number
	status: TodoStatus
	activeForm?: string
	note?: string
}

interface ClearTodosParams {
	scope?: unknown
}

function todoErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function normalizeTodoId(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error("Todo id must be a positive integer")
	}
	return value
}

function normalizeTodoStatus(value: unknown, fallback: TodoStatus = "pending"): TodoStatus {
	if (value === undefined) return fallback
	const status = typeof value === "string" ? value.trim() : ""
	if (TODO_STATUSES.includes(status as TodoStatus)) return status as TodoStatus
	throw new Error(`Invalid todo status '${String(value)}'`)
}

function scopedTodos(scopeInput: unknown): { scope: ReturnType<typeof resolveTodoScope>; todos: TodoItem[] } {
	const scope = resolveTodoScope(scopeInput)
	return { scope, todos: getTodosForScope(scope) }
}

function todoDraftWithOptionalFields(params: AddTodoParams): TodoDraft {
	const content = typeof params.content === "string" ? params.content.trim().replace(/\s+/g, " ") : ""
	if (!content) throw new Error("Todo content is required")
	return {
		content,
		status: normalizeTodoStatus(params.status),
		...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
		...(params.note !== undefined ? { note: params.note } : {}),
	}
}

async function executeWriteTodos(_toolCallId: string, params: WriteTodosParams) {
	try {
		const details = applyWriteTodos(params)
		return {
			content: [{ type: "text" as const, text: `Updated ${details.todos.length} todos.` }],
			details,
		}
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: `Failed to write todos: ${todoErrorMessage(error)}` }],
			details: null,
		}
	}
}

async function executeAddTodo(_toolCallId: string, params: AddTodoParams) {
	try {
		const { scope, todos } = scopedTodos(params.scope)
		const knownIds = new Set(todos.map((todo) => todo.id))
		const details = applyWriteTodos({ scope, todos: [...todos, todoDraftWithOptionalFields(params)] })
		// Storage order is id-based; identify the new item by id rather than position.
		const added = details.todos.find((todo) => !knownIds.has(todo.id))
		return {
			content: [{ type: "text" as const, text: added ? `Added todo #${added.id}.` : "Added todo." }],
			details,
		}
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: `Failed to add todo: ${todoErrorMessage(error)}` }],
			details: null,
		}
	}
}

async function executeMarkTodo(_toolCallId: string, params: MarkTodoParams) {
	try {
		const id = normalizeTodoId(params.id)
		const status = normalizeTodoStatus(params.status)
		const { scope, todos } = scopedTodos(params.scope)
		let found = false
		const nextTodos = todos.map((todo) => {
			if (todo.id !== id) return todo
			found = true
			return {
				...todo,
				status,
				...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
				...(params.note !== undefined ? { note: params.note } : {}),
			}
		})
		if (!found) throw new Error(`Todo #${id} not found`)

		const details = applyWriteTodos({ scope, todos: nextTodos })
		return {
			content: [{ type: "text" as const, text: `Marked todo #${id} ${status}.` }],
			details,
		}
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: `Failed to mark todo: ${todoErrorMessage(error)}` }],
			details: null,
		}
	}
}

async function executeClearTodos(_toolCallId: string, params: ClearTodosParams) {
	try {
		const scope = resolveTodoScope(params.scope)
		const details = applyWriteTodos({ scope, todos: [] })
		return {
			content: [{ type: "text" as const, text: "Cleared todos." }],
			details,
		}
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: `Failed to clear todos: ${todoErrorMessage(error)}` }],
			details: null,
		}
	}
}

export function registerTodosTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: UPDATE_TODOS_TOOL_NAME,
		label: "Update Todos",
		description: "Update todo progress by replacing the current todo list. Use after meaningful progress.",
		promptSnippet: "Replace the todo list for batch progress updates",
		parameters: TODO_TOOL_PARAMETERS,
		execute: executeWriteTodos,
	})

	pi.registerTool({
		name: ADD_TODO_TOOL_NAME,
		label: "Add Todo",
		description: "Add one todo to the current list. Use for a missing follow-up item.",
		promptSnippet: "Add a single todo item",
		parameters: ADD_TODO_PARAMETERS,
		execute: executeAddTodo,
	})

	pi.registerTool({
		name: MARK_TODO_TOOL_NAME,
		label: "Mark Todo",
		description: "Mark one todo as pending, in_progress, blocked, or completed by id.",
		promptSnippet: "Mark one todo's progress by id",
		parameters: MARK_TODO_PARAMETERS,
		execute: executeMarkTodo,
	})

	pi.registerTool({
		name: CLEAR_TODOS_TOOL_NAME,
		label: "Clear Todos",
		description: "Clear the current todo list when the work is done or obsolete.",
		promptSnippet: "Clear the todo list",
		parameters: CLEAR_TODOS_PARAMETERS,
		execute: executeClearTodos,
	})
}
