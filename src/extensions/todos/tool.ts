import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { validateExplicitTodoScope } from "./scope.js"
import { applyWriteTodos, getTodosForScope, resolveTodoScope } from "./store.js"
import { TODO_STATUSES, type TodoDraft, type TodoScope, type TodoStatus, type WriteTodosParams } from "./types.js"

export const TODOS_TOOL_NAME = "todos"
// Legacy per-action tool names, kept for session-log recognition
// (isTodoWriteToolName) and ferment-v2 shape detection — old session
// transcripts and in-flight tests still carry them. Never registered.
export const UPDATE_TODOS_TOOL_NAME = "update_todos"
export const CREATE_TODOS_TOOL_NAME = "create_todos"
export const ADD_TODO_TOOL_NAME = "add_todo"
export const MARK_TODO_TOOL_NAME = "mark_todo"
export const CLEAR_TODOS_TOOL_NAME = "clear_todos"
export const LEGACY_TODO_TOOL_NAMES = [
	CREATE_TODOS_TOOL_NAME,
	UPDATE_TODOS_TOOL_NAME,
	ADD_TODO_TOOL_NAME,
	MARK_TODO_TOOL_NAME,
	CLEAR_TODOS_TOOL_NAME,
] as const
/** The only todo tool the model sees: the consolidated action tool. */
export const TODO_TOOL_NAMES = [TODOS_TOOL_NAME] as const

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

const TODOS_TOOL_PARAMETERS = Type.Object({
	action: Type.Union(
		[Type.Literal("create"), Type.Literal("update"), Type.Literal("add"), Type.Literal("mark"), Type.Literal("clear")],
		{
			description:
				"'create' = initial list for non-trivial work; 'update' = replace the whole list when the plan changes significantly; 'add' = append one item; 'mark' = routine status change by id (the default for progress updates); 'clear' = wipe the list when done or obsolete.",
		},
	),
	scope: Type.Optional(Type.Any({ description: SCOPE_DESCRIPTION })),
	todos: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(Type.Number()),
				content: Type.String(),
				status: TODO_STATUS_PARAMETER,
				activeForm: Type.Optional(Type.String({ description: ACTIVE_FORM_DESCRIPTION })),
				note: Type.Optional(Type.String()),
			}),
			{ description: "The full list. Required for create/update." },
		),
	),
	content: Type.Optional(Type.String({ description: "The single item text. Required for add." })),
	id: Type.Optional(Type.Number({ description: "The todo id. Required for mark." })),
	status: Type.Optional(Type.Union([TODO_STATUS_PARAMETER], { description: "Required for mark; optional for add." })),
	activeForm: Type.Optional(Type.String({ description: ACTIVE_FORM_DESCRIPTION })),
	note: Type.Optional(Type.String()),
})

type TodoAction = "create" | "update" | "add" | "mark" | "clear"

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

/**
 * Action dispatch helper for transcripts/tool-call blocks: with the
 * consolidated tool the model calls `todos` with an `action` argument; older
 * session logs carry the five legacy tool names. Returns the action for
 * either shape, undefined for non-todo calls.
 */
export function todoActionOf(toolName: string, args: unknown): TodoAction | undefined {
	if (toolName === TODOS_TOOL_NAME) {
		const action = isRecord(args) ? args.action : undefined
		return typeof action === "string" ? (action as TodoAction) : undefined
	}
	switch (toolName) {
		case CREATE_TODOS_TOOL_NAME:
			return "create"
		case UPDATE_TODOS_TOOL_NAME:
			return "update"
		case ADD_TODO_TOOL_NAME:
			return "add"
		case MARK_TODO_TOOL_NAME:
			return "mark"
		case CLEAR_TODOS_TOOL_NAME:
			return "clear"
		default:
			return undefined
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
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
		const existing = todos.find((todo) => todo.id === id)
		if (!existing) {
			// Soft steer, not an error: an unknown id usually means the list was
			// replaced (e.g. by update or another scope) — tell the model to
			// re-read state rather than retry the same mark.
			return {
				content: [
					{
						type: "text" as const,
						text: `Todo #${id} doesn't exist in ${formatScopeLabel(scope)} — the list may have been replaced. Check the current ids in the todo list before marking again.`,
					},
				],
				details: null,
			}
		}

		// No-op fast path: same status and no field changes — skip the write
		// (and the session-branch churn that comes with it) and tell the model
		// not to re-mark, so duplicate marks don't look productive.
		if (existing.status === status && params.activeForm === undefined && params.note === undefined) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Todo #${id} is already '${status}' — no change made. Don't re-mark todos whose status hasn't changed.`,
					},
				],
				details: null,
			}
		}

		const nextTodos = todos.map((todo) => {
			if (todo.id !== id) return todo
			return {
				...todo,
				status,
				...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
				...(params.note !== undefined ? { note: params.note } : {}),
			}
		})

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
	params: { scope?: unknown },
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

function argError(text: string) {
	return { content: [{ type: "text" as const, text }], details: null }
}

async function executeTodos(
	toolCallId: string,
	params: {
		action: TodoAction
		scope?: unknown
		todos?: Array<{ id?: number; content: string; status: TodoStatus; activeForm?: string; note?: string }>
		content?: string
		id?: number
		status?: TodoStatus
		activeForm?: string
		note?: string
	},
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: ExtensionContext,
) {
	switch (params.action) {
		case "create":
		case "update":
			if (!Array.isArray(params.todos)) {
				return argError(`Error: todos action "${params.action}" requires the \`todos\` array.`)
			}
			return executeWriteTodos(toolCallId, { scope: params.scope, todos: params.todos }, signal, onUpdate, ctx)
		case "add":
			if (typeof params.content !== "string" || !params.content.trim()) {
				return argError('Error: todos action "add" requires `content`.')
			}
			return executeAddTodo(toolCallId, params as AddTodoParams, signal, onUpdate, ctx)
		case "mark":
			if (params.id === undefined) {
				return argError('Error: todos action "mark" requires `id`.')
			}
			if (params.status === undefined) {
				return argError('Error: todos action "mark" requires `status`.')
			}
			return executeMarkTodo(toolCallId, params as MarkTodoParams, signal, onUpdate, ctx)
		case "clear":
			return executeClearTodos(toolCallId, params, signal, onUpdate, ctx)
		default:
			return argError(
				`Unknown todos action "${String(params.action)}". Valid actions: create, update, add, mark, clear.`,
			)
	}
}

export function registerTodosTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TODOS_TOOL_NAME,
		label: "Todos",
		description:
			"Manage the session todo list. Actions: 'create' = initial list for non-trivial work; 'update' = replace the whole list when the plan changes significantly; 'add' = append one item; 'mark' = routine status change by id (the primary progress update); 'clear' = wipe when done or obsolete. Always pair a todos call with the next work tool call in the same turn — never make a turn that is only a todo update. Keep at most one in_progress; preserve user-created todos and existing ids.",
		promptSnippet: "manage the session todo list (create/update/add/mark/clear)",
		parameters: TODOS_TOOL_PARAMETERS,
		executionMode: "parallel",
		execute: executeTodos,
	})
}
