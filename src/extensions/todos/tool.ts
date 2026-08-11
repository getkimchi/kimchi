import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { validateExplicitTodoScope } from "./scope.js"
import { applyWriteTodos, getTodosForScope, resolveTodoScope } from "./store.js"
import { TODO_STATUSES, type TodoDraft, type TodoScope, type TodoStatus, type WriteTodosParams } from "./types.js"

export const UPDATE_TODOS_TOOL_NAME = "update_todos"
export const CREATE_TODOS_TOOL_NAME = "create_todos"
export const ADD_TODO_TOOL_NAME = "add_todo"
export const MARK_TODO_TOOL_NAME = "mark_todo"
export const CLEAR_TODOS_TOOL_NAME = "clear_todos"
export const TODO_TOOL_NAMES = [
	CREATE_TODOS_TOOL_NAME,
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

const SCOPE_DESCRIPTION =
	'Which todo list to target. Omit for auto-routing: while exactly one ferment step is running, writes go to that step\'s list; otherwise they go to the global list. To target a specific list, pass {kind:"global"}, {kind:"ferment-step",phaseId:"...",stepId:"..."}. The ferment phase scope ({kind:"ferment",phaseId}) is managed by the ferment lifecycle and cannot be written directly.'

const ACTIVE_FORM_DESCRIPTION =
	"Present-continuous label shown while the item is in progress, e.g. 'Writing auth tests'. Not a category tag like 'task' or 'step'."

const TODO_TOOL_PARAMETERS = Type.Object({
	scope: Type.Optional(Type.Any({ description: SCOPE_DESCRIPTION })),
	todos: Type.Array(
		Type.Object({
			id: Type.Optional(Type.Number()),
			content: Type.String(),
			status: TODO_STATUS_PARAMETER,
			activeForm: Type.Optional(Type.String({ description: ACTIVE_FORM_DESCRIPTION })),
			note: Type.Optional(Type.String()),
		}),
	),
})

const ADD_TODO_PARAMETERS = Type.Object({
	scope: Type.Optional(Type.Any({ description: SCOPE_DESCRIPTION })),
	content: Type.String(),
	status: Type.Optional(TODO_STATUS_PARAMETER),
	activeForm: Type.Optional(Type.String({ description: ACTIVE_FORM_DESCRIPTION })),
	note: Type.Optional(Type.String()),
})

const MARK_TODO_PARAMETERS = Type.Object({
	scope: Type.Optional(Type.Any({ description: SCOPE_DESCRIPTION })),
	id: Type.Number(),
	status: TODO_STATUS_PARAMETER,
	activeForm: Type.Optional(Type.String({ description: ACTIVE_FORM_DESCRIPTION })),
	note: Type.Optional(Type.String()),
})

const CLEAR_TODOS_PARAMETERS = Type.Object({
	scope: Type.Optional(Type.Any({ description: SCOPE_DESCRIPTION })),
})

const FERMENT_SCOPE_ERROR =
	"Phase todo lists are managed by the ferment lifecycle; write your tasks to the step scope (omit scope while a step runs) or to global."

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

/** Human-readable label for a resolved scope, used in tool output. */
function formatScopeLabel(scope: TodoScope): string {
	if (scope.kind === "global") return "global"
	if (scope.kind === "ferment") return `phase ${scope.phaseId}`
	if (scope.kind === "ferment-step") return `step ${scope.phaseId}/${scope.stepId}`
	return "global"
}

/** Validate an explicit scope, then auto-route if omitted. Rejects malformed
 *  scopes (instead of silently collapsing to global) and rejects writes to
 *  the ferment phase scope (managed by the bridge). */
function resolveToolScope(scopeInput: unknown): { scope: TodoScope } | { error: string } {
	const validated = validateExplicitTodoScope(scopeInput)
	if (validated.error) return { error: validated.error }
	if (validated.scope) {
		if (validated.scope.kind === "ferment") return { error: FERMENT_SCOPE_ERROR }
		return { scope: validated.scope }
	}
	// Empty/omitted scope — auto-route via providers.
	const scope = resolveTodoScope(scopeInput)
	if (scope.kind === "ferment") return { error: FERMENT_SCOPE_ERROR }
	return { scope }
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

async function executeWriteTodos(
	_toolCallId: string,
	params: WriteTodosParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const sessionId = ctx.sessionManager.getSessionId()
	try {
		const resolved = resolveToolScope(params.scope)
		if ("error" in resolved) {
			return { content: [{ type: "text" as const, text: resolved.error }], details: null }
		}
		const details = applyWriteTodos({ scope: resolved.scope, todos: params.todos }, sessionId)
		const label = formatScopeLabel(details.scope)
		return {
			content: [{ type: "text" as const, text: `Updated ${details.todos.length} todos in ${label}.` }],
			details,
		}
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: `Failed to write todos: ${todoErrorMessage(error)}` }],
			details: null,
		}
	}
}

async function executeAddTodo(
	_toolCallId: string,
	params: AddTodoParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const sessionId = ctx.sessionManager.getSessionId()
	try {
		const resolved = resolveToolScope(params.scope)
		if ("error" in resolved) {
			return { content: [{ type: "text" as const, text: resolved.error }], details: null }
		}
		const scope = resolved.scope
		const todos = getTodosForScope(scope, sessionId)
		const knownIds = new Set(todos.map((todo) => todo.id))
		const details = applyWriteTodos({ scope, todos: [...todos, todoDraftWithOptionalFields(params)] }, sessionId)
		const added = details.todos.find((todo) => !knownIds.has(todo.id))
		const label = formatScopeLabel(details.scope)
		return {
			content: [
				{ type: "text" as const, text: added ? `Added todo #${added.id} in ${label}.` : `Added todo in ${label}.` },
			],
			details,
		}
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: `Failed to add todo: ${todoErrorMessage(error)}` }],
			details: null,
		}
	}
}

async function executeMarkTodo(
	_toolCallId: string,
	params: MarkTodoParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const sessionId = ctx.sessionManager.getSessionId()
	try {
		const id = normalizeTodoId(params.id)
		const status = normalizeTodoStatus(params.status)
		const resolved = resolveToolScope(params.scope)
		if ("error" in resolved) {
			return { content: [{ type: "text" as const, text: resolved.error }], details: null }
		}
		const scope = resolved.scope
		const todos = getTodosForScope(scope, sessionId)
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
		if (!found) {
			const label = formatScopeLabel(scope)
			throw new Error(`Todo #${id} not found in ${label}`)
		}

		const details = applyWriteTodos({ scope, todos: nextTodos }, sessionId)
		const label = formatScopeLabel(details.scope)
		return {
			content: [{ type: "text" as const, text: `Marked todo #${id} ${status} in ${label}.` }],
			details,
		}
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: `Failed to mark todo: ${todoErrorMessage(error)}` }],
			details: null,
		}
	}
}

async function executeClearTodos(
	_toolCallId: string,
	params: ClearTodosParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const sessionId = ctx.sessionManager.getSessionId()
	try {
		const resolved = resolveToolScope(params.scope)
		if ("error" in resolved) {
			return { content: [{ type: "text" as const, text: resolved.error }], details: null }
		}
		const details = applyWriteTodos({ scope: resolved.scope, todos: [] }, sessionId)
		const label = formatScopeLabel(details.scope)
		return {
			content: [{ type: "text" as const, text: `Cleared todos in ${label}.` }],
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
		name: CREATE_TODOS_TOOL_NAME,
		label: "Create Todos",
		description:
			"Create the initial todo list for non-trivial work. Use before starting multi-step tasks, when the user asks you to track work, or when there is no current todo list. Always pair this with the first work tool call in the same turn — do not make a turn that is only a todo creation.",
		promptSnippet: "Create the initial todo list before multi-step work",
		parameters: TODO_TOOL_PARAMETERS,
		executionMode: "parallel",
		execute: executeWriteTodos,
	})

	pi.registerTool({
		name: UPDATE_TODOS_TOOL_NAME,
		label: "Update Todos",
		description:
			"Replace the entire todo list. Use only when the plan changes significantly (adding, removing, or reordering items). For routine status changes, use mark_todo instead — it is lighter and pairs more naturally with a work tool call. Always pair this with the next work tool call in the same turn — never make a turn that is only a todo update.",
		promptSnippet: "Replace the todo list for batch progress updates",
		parameters: TODO_TOOL_PARAMETERS,
		executionMode: "parallel",
		execute: executeWriteTodos,
	})

	pi.registerTool({
		name: ADD_TODO_TOOL_NAME,
		label: "Add Todo",
		description:
			"Add one todo to the current list. Use for a missing follow-up item. Pair this with the next work tool call in the same turn when possible.",
		promptSnippet: "Add a single todo item",
		parameters: ADD_TODO_PARAMETERS,
		executionMode: "parallel",
		execute: executeAddTodo,
	})

	pi.registerTool({
		name: MARK_TODO_TOOL_NAME,
		label: "Mark Todo",
		description:
			"Mark one todo as pending, in_progress, blocked, or completed by id. This is the primary tool for routine progress updates — use it to mark the current item completed and the next one in_progress as you work. Always pair this with the next work tool call in the same turn — never make a turn that is only a todo status change.",
		promptSnippet: "Mark one todo's progress by id",
		parameters: MARK_TODO_PARAMETERS,
		executionMode: "parallel",
		execute: executeMarkTodo,
	})

	pi.registerTool({
		name: CLEAR_TODOS_TOOL_NAME,
		label: "Clear Todos",
		description:
			"Clear the current todo list when the work is done or obsolete. Pair this with the next work tool call in the same turn when possible.",
		promptSnippet: "Clear the todo list",
		parameters: CLEAR_TODOS_PARAMETERS,
		executionMode: "parallel",
		execute: executeClearTodos,
	})
}
