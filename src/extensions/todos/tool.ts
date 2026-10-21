import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { reconcileCheckinScope, reportConfirmMismatch } from "./checkin-gate.js"
import { getInputRevision, recordScopeReconciliation, takeAdmittedInputRevision } from "./reconciliation.js"
import { validateExplicitTodoScope } from "./scope.js"
import { renderTodoEntries } from "./state-markdown.js"
import { applyTodoMutation, applyWriteTodos, getTodosForScope, resolveTodoScope } from "./store.js"
import {
	TODO_STATUSES,
	TODO_TOOL_RESULT_SCHEMA_VERSION,
	type TodoDraft,
	type TodoItem,
	type TodoScope,
	type TodoStatus,
	type TodoWriteContext,
	type WriteTodosParams,
} from "./types.js"

export const UPDATE_TODOS_TOOL_NAME = "update_todos"
export const CREATE_TODOS_TOOL_NAME = "create_todos"
export const ADD_TODO_TOOL_NAME = "add_todo"
export const MARK_TODO_TOOL_NAME = "mark_todo"
export const CLEAR_TODOS_TOOL_NAME = "clear_todos"
export const CONFIRM_TODOS_TOOL_NAME = "confirm_todos"
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

/** Real assistant writes reconcile their scope against the input revision
 *  accepted when the call was admitted (captured at the tool_call hook) —
 *  not the newest revision, which may have arrived while the call was
 *  executing. */
function toolWriteContext(sessionId: string, toolCallId: string): TodoWriteContext {
	return {
		origin: "tool",
		inputRevision: takeAdmittedInputRevision(sessionId, toolCallId) ?? getInputRevision(sessionId),
	}
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
function resolveToolScope(scopeInput: unknown, sessionId: string): { scope: TodoScope } | { error: string } {
	const validated = validateExplicitTodoScope(scopeInput)
	if (validated.error) return { error: validated.error }
	if (validated.scope) {
		if (validated.scope.kind === "ferment") return { error: FERMENT_SCOPE_ERROR }
		return { scope: validated.scope }
	}
	// Empty/omitted scope — auto-route via this session's providers.
	const scope = resolveTodoScope(sessionId, scopeInput)
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
	toolCallId: string,
	params: WriteTodosParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const sessionId = ctx.sessionManager.getSessionId()
	try {
		const resolved = resolveToolScope(params.scope, sessionId)
		if ("error" in resolved) {
			return { content: [{ type: "text" as const, text: resolved.error }], details: null }
		}
		const details = applyWriteTodos(
			{ scope: resolved.scope, todos: params.todos },
			sessionId,
			toolWriteContext(sessionId, toolCallId),
		)
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
	toolCallId: string,
	params: AddTodoParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const sessionId = ctx.sessionManager.getSessionId()
	try {
		const resolved = resolveToolScope(params.scope, sessionId)
		if ("error" in resolved) {
			return { content: [{ type: "text" as const, text: resolved.error }], details: null }
		}
		const scope = resolved.scope
		// Atomic add: the read (known ids) and the write happen inside
		// applyTodoMutation's synchronous window, so parallel adds cannot
		// drop each other.
		let knownIds = new Set<number>()
		const details = applyTodoMutation(
			scope,
			sessionId,
			(todos) => {
				knownIds = new Set(todos.map((todo) => todo.id))
				return [...todos, todoDraftWithOptionalFields(params)]
			},
			toolWriteContext(sessionId, toolCallId),
		)
		if (!details) throw new Error("mutation produced no result")
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
	toolCallId: string,
	params: MarkTodoParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const sessionId = ctx.sessionManager.getSessionId()
	try {
		const id = normalizeTodoId(params.id)
		const status = normalizeTodoStatus(params.status)
		const resolved = resolveToolScope(params.scope, sessionId)
		if ("error" in resolved) {
			return { content: [{ type: "text" as const, text: resolved.error }], details: null }
		}
		const scope = resolved.scope
		// Atomic mark: the existence check, no-op detection, and the write all
		// happen inside applyTodoMutation's synchronous window — the snapshot
		// the mutator sees cannot change between read and commit.
		let unknownId = false
		let noOp = false
		const details = applyTodoMutation(
			scope,
			sessionId,
			(todos) => {
				const existing = todos.find((todo) => todo.id === id)
				if (!existing) {
					// Soft steer, not an error: an unknown id usually means the list was
					// replaced (e.g. by update_todos or another scope) — tell the model to
					// re-read state rather than retry the same mark.
					unknownId = true
					return undefined
				}

				// No-op fast path: same status and no field changes — skip the write
				// (and the session-branch churn that comes with it) and tell the model
				// not to re-mark, so duplicate marks don't look productive.
				if (existing.status === status && params.activeForm === undefined && params.note === undefined) {
					noOp = true
					return undefined
				}

				return todos.map((todo) => {
					if (todo.id !== id) return todo
					return {
						...todo,
						status,
						...(params.activeForm !== undefined ? { activeForm: params.activeForm } : {}),
						...(params.note !== undefined ? { note: params.note } : {}),
					}
				})
			},
			toolWriteContext(sessionId, toolCallId),
		)
		if (unknownId) {
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
		if (noOp) {
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
		if (!details) throw new Error("mutation produced no result")
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
	toolCallId: string,
	params: ClearTodosParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const sessionId = ctx.sessionManager.getSessionId()
	try {
		const resolved = resolveToolScope(params.scope, sessionId)
		if ("error" in resolved) {
			return { content: [{ type: "text" as const, text: resolved.error }], details: null }
		}
		const details = applyWriteTodos(
			{ scope: resolved.scope, todos: [] },
			sessionId,
			toolWriteContext(sessionId, toolCallId),
		)
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

interface ConfirmTodosParams {
	scope?: unknown
	inputRevision: number
	expected: Array<{ id: number; status: TodoStatus }>
}

const CONFIRM_TODOS_PARAMETERS = Type.Object({
	scope: Type.Optional(Type.Any({ description: SCOPE_DESCRIPTION })),
	inputRevision: Type.Number({
		description:
			"The current input revision from the todo check-in instructions. A revision from older instructions is rejected — the user's latest input must be acknowledged.",
	}),
	expected: Type.Array(
		Type.Object({
			id: Type.Number({ description: "The todo id as it currently exists in the list." }),
			status: TODO_STATUS_PARAMETER,
		}),
		{
			description:
				"The complete expected id+status set of the list being confirmed — every current todo id with the status you believe it has, and nothing else.",
		},
	),
})

/** Compact one-line rendering of a list for confirm_todos read-backs,
 *  sharing the entry format with every other check-in surface. */
function renderTodosForConfirm(todos: readonly TodoItem[]): string {
	return renderTodoEntries(todos, { empty: "(the list is empty)", separator: "; " })
}

/** Confirm that a list still matches the current plan without writing it.
 *  Requires the complete current id+status set and the current input
 *  revision; a wrong set or stale revision is rejected with the actual
 *  state so the check-in stays pending. */
async function executeConfirmTodos(
	_toolCallId: string,
	params: ConfirmTodosParams,
	_signal: AbortSignal | undefined,
	_onUpdate: unknown,
	ctx: ExtensionContext,
) {
	const sessionId = ctx.sessionManager.getSessionId()
	try {
		const resolved = resolveToolScope(params.scope, sessionId)
		if ("error" in resolved) {
			return { content: [{ type: "text" as const, text: resolved.error }], details: null }
		}
		const scope = resolved.scope
		const todos = getTodosForScope(scope, sessionId)
		const currentRevision = getInputRevision(sessionId)
		const label = formatScopeLabel(scope)

		if (params.inputRevision !== currentRevision) {
			reportConfirmMismatch(scope, sessionId, "stale_revision")
			return {
				content: [
					{
						type: "text" as const,
						text: `The accepted input revision is now ${currentRevision} (you confirmed revision ${params.inputRevision}) — newer user input arrived after this confirmation was prepared. Reconcile the ${label} list against the latest direction, then confirm against revision ${currentRevision}. Current list: ${renderTodosForConfirm(todos)}`,
					},
				],
				details: null,
			}
		}

		// Item shape (numeric id, status one of the four literals) is guaranteed
		// by the Typebox schema; only genuine set mismatches are validated here.
		const seen = new Set<number>()
		const problems: string[] = []
		for (const item of params.expected) {
			if (!Number.isInteger(item.id) || item.id <= 0) {
				problems.push(`invalid id ${item.id}`)
				continue
			}
			if (seen.has(item.id)) problems.push(`duplicate id ${item.id}`)
			seen.add(item.id)
		}
		const currentIds = new Set(todos.map((todo) => todo.id))
		for (const id of seen) {
			if (!currentIds.has(id)) problems.push(`unknown id ${id}`)
		}
		for (const id of currentIds) {
			if (!seen.has(id)) problems.push(`missing id ${id}`)
		}
		const mismatched = todos.filter((todo) => {
			const item = params.expected.find((entry) => entry.id === todo.id)
			return !item || item.status !== todo.status
		})
		if (problems.length > 0 || mismatched.length > 0) {
			reportConfirmMismatch(scope, sessionId, "mismatch")
			const reasons = [...new Set(problems)]
			if (mismatched.length > 0) reasons.push("status mismatches")
			return {
				content: [
					{
						type: "text" as const,
						text: `The confirmed set does not match the current ${label} list (${reasons.join(", ")}). Current list: ${renderTodosForConfirm(todos)} — current input revision ${currentRevision}. Update the list with the todo tools instead, or confirm the exact current id+status set.`,
					},
				],
				details: null,
			}
		}

		// Success: an unchanged, accurate list is confirmed without a store
		// write. Reconciliation is recorded for closure suppression and the
		// gate closes via its own change notification (no synthetic write).
		recordScopeReconciliation(scope, sessionId, currentRevision)
		reconcileCheckinScope(scope, sessionId, currentRevision, "confirm")
		return {
			content: [
				{
					type: "text" as const,
					text: `Confirmed ${todos.length} todos in ${label} match the current plan (input revision ${currentRevision}).`,
				},
			],
			details: {
				schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
				scope,
				todos,
				confirmedAt: new Date().toISOString(),
				inputRevision: currentRevision,
			},
		}
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: `Failed to confirm todos: ${todoErrorMessage(error)}` }],
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
			"Replace the entire todo list. Use only when the plan changes significantly (adding, removing, or reordering items). For routine status changes, use mark_todo instead — it is lighter and pairs more naturally with a work tool call. For appending a single item, use add_todo instead of rewriting the whole list. Pair this with work tool calls when possible; todo-only cleanup is appropriate at wrap-up.",
		promptSnippet: "Replace the whole todo list when the plan changes",
		parameters: TODO_TOOL_PARAMETERS,
		executionMode: "parallel",
		execute: executeWriteTodos,
	})

	pi.registerTool({
		name: ADD_TODO_TOOL_NAME,
		label: "Add Todo",
		description:
			"Add one todo to the current list. Use for a missing follow-up item. Prefer this over rewriting the whole list with update_todos just to append one item. Pair this with the next work tool call in the same turn when possible.",
		promptSnippet: "Add one todo — prefer over rewriting the list",
		parameters: ADD_TODO_PARAMETERS,
		executionMode: "parallel",
		execute: executeAddTodo,
	})

	pi.registerTool({
		name: MARK_TODO_TOOL_NAME,
		label: "Mark Todo",
		description:
			"Mark one todo as pending, in_progress, blocked, or completed by id. This is the primary tool for routine progress updates — use it to mark the current item completed and the next one in_progress as you work. Pair this with work tool calls when possible; todo-only cleanup is appropriate at wrap-up.",
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

	pi.registerTool({
		name: CONFIRM_TODOS_TOOL_NAME,
		label: "Confirm Todos",
		description:
			"Confirm a todo list still matches the current plan without writing it — the check-in path for an unchanged list. Pass the complete current id+status set and the inputRevision from the todo check-in instructions; a wrong set or stale revision is rejected with the actual list. When the list needs changes, use the todo write tools instead.",
		promptSnippet: "Confirm an unchanged todo list for the check-in gate",
		parameters: CONFIRM_TODOS_PARAMETERS,
		executionMode: "parallel",
		execute: executeConfirmTodos,
	})
}
