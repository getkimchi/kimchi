import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { reconcileCheckinScope, reportConfirmMismatch } from "./checkin-gate.js"
import { getInputRevision, recordScopeReconciliation, takeAdmittedInputRevision } from "./reconciliation.js"
import { normalizeOptionalText, normalizeText } from "./reducer.js"
import { validateExplicitTodoScope } from "./scope.js"
import { renderTodoEntries } from "./state-markdown.js"
import { applyTodoMutation, applyWriteTodos, getTodosForScope, resolveTodoScope } from "./store.js"
import {
	TODO_TOOL_RESULT_SCHEMA_VERSION,
	type TodoDraft,
	type TodoItem,
	type TodoScope,
	type TodoStatus,
	type TodoWriteContext,
	type WriteTodosDetails,
	type WriteTodosParams,
} from "./types.js"

export const TODOS_TOOL_NAME = "todos"
/** Live tools — the single registered todo tool. The retired names
 *  (historical transcript classification) live in session.ts. */
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

const TODO_TOOL_PARAMETERS = Type.Object({
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
			{
				description:
					"Complete list — create a new list, or deliberately replace the current one. Every item you want to keep must appear; omitted items are deleted (the result names them).",
			},
		),
	),
	update: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Number({ description: "The id of the existing item to change." }),
				status: Type.Optional(TODO_STATUS_PARAMETER),
				content: Type.Optional(Type.String()),
				activeForm: Type.Optional(Type.String({ description: ACTIVE_FORM_DESCRIPTION })),
				note: Type.Optional(
					Type.String({ description: 'Omitted keeps the stored value; an explicit value replaces it, "" clears it.' }),
				),
			}),
			{
				description:
					"Targeted edits to existing items — pass only the items that change, with only the fields that change (omitted fields keep their stored value).",
			},
		),
	),
	add: Type.Optional(
		Type.Array(
			Type.Object({
				content: Type.String(),
				status: Type.Optional(TODO_STATUS_PARAMETER),
				activeForm: Type.Optional(Type.String({ description: ACTIVE_FORM_DESCRIPTION })),
				note: Type.Optional(Type.String()),
			}),
			{ description: "New items to append. Fresh ids are assigned." },
		),
	),
	remove: Type.Optional(Type.Array(Type.Number(), { description: "Ids of items to delete." })),
	confirm: Type.Optional(
		Type.Number({
			description:
				"Close a todo check-in on an unchanged list: pass the input revision from the check-in instructions (a stale revision is rejected). Only `scope` may accompany it.",
		}),
	),
})

export interface TodoEditParams {
	id: number
	status?: TodoStatus
	content?: string
	activeForm?: string
	note?: string
}

export interface TodoAddParams {
	content: string
	status?: TodoStatus
	activeForm?: string
	note?: string
}

export interface TodosToolParams {
	scope?: unknown
	todos?: NonNullable<WriteTodosParams["todos"]>
	update?: TodoEditParams[]
	add?: TodoAddParams[]
	remove?: number[]
	confirm?: number
}

export type TodoCallProjection =
	| { kind: "projected"; todos: TodoDraft[] }
	| { kind: "error"; error: string }
	| { kind: "confirm"; revision: number }
	| { kind: "invalid"; error: string }

const FERMENT_SCOPE_ERROR =
	"Phase todo lists are managed by the ferment lifecycle; write your tasks to the step scope (omit scope while a step runs) or to global."

const MODE_ERROR =
	"Pass exactly one mode: `todos` (full list), any combination of `update`/`add`/`remove` (targeted edits), or `confirm` (check-in). Modes cannot be combined."

/** Project what a `todos` call would store against a current list, without
 *  writing. Shared by the executor and by ferment-v2 completion detection so
 *  the two can't drift. Edits apply in a fixed order — remove, update, add —
 *  and unknown ids reject the whole call with the live id set. */
export function projectTodoCall(current: readonly TodoItem[], params: TodosToolParams): TodoCallProjection {
	const hasTodos = params.todos !== undefined
	const hasConfirm = params.confirm !== undefined
	const updates = (params.update ?? []).filter(Boolean)
	const adds = (params.add ?? []).filter(Boolean)
	const removals = params.remove ?? []
	const hasEdits = updates.length > 0 || adds.length > 0 || removals.length > 0

	if (hasConfirm) {
		if (hasTodos || hasEdits) return { kind: "invalid", error: MODE_ERROR }
		return { kind: "confirm", revision: params.confirm as number }
	}
	if (!hasTodos && !hasEdits) return { kind: "invalid", error: MODE_ERROR }
	if (hasTodos) {
		if (hasEdits) return { kind: "invalid", error: MODE_ERROR }
		return { kind: "projected", todos: params.todos as TodoDraft[] }
	}

	// Content is what a todo IS: an edit that empties it deletes nothing — it
	// errors. (The retired executors rejected this; the reducer drops
	// empty-content drafts silently, which would turn this call into a
	// phantom write.)
	const emptyAdds = adds.filter((draft) => !normalizeText(draft.content))
	const emptyEdits = updates.filter((edit) => edit.content !== undefined && !normalizeText(edit.content))
	if (emptyAdds.length > 0 || emptyEdits.length > 0) {
		const parts = [
			emptyAdds.length > 0 ? `${emptyAdds.length} add(s) with empty content` : undefined,
			emptyEdits.length > 0
				? `update(s) with empty content: ${emptyEdits.map((edit) => `#${edit.id}`).join(", ")}`
				: undefined,
		]
			.filter(Boolean)
			.join("; ")
		return { kind: "error", error: `${parts} — content is required. Nothing was changed.` }
	}

	const byId = new Map(current.map((todo) => [todo.id, todo]))
	const referenced = [...removals, ...updates.map((edit) => edit.id)]
	const unknown = referenced.filter((id) => !byId.get(id))
	if (unknown.length > 0) {
		return {
			kind: "error",
			error: `Unknown todo id(s): ${unknown.join(", ")}. Current ids: ${current.map((todo) => `#${todo.id}`).join(", ") || "(none)"} — nothing was changed. Current list: ${renderTodoEntries(current, { empty: "(the list is empty)", separator: "; " })}`,
		}
	}
	const removed = new Set(removals)
	const edited = new Map(updates.map((edit) => [edit.id, edit]))
	const kept: TodoDraft[] = []
	for (const todo of current) {
		if (removed.has(todo.id)) continue
		const edit = edited.get(todo.id)
		kept.push(
			edit
				? {
						id: todo.id,
						content: edit.content ?? todo.content,
						status: edit.status ?? todo.status,
						activeForm: edit.activeForm ?? todo.activeForm,
						note: edit.note ?? todo.note,
						_syncKey: todo._syncKey,
					}
				: { ...todo },
		)
	}
	for (const add of adds) {
		kept.push({
			content: add.content,
			status: add.status ?? "pending",
			...(add.activeForm !== undefined ? { activeForm: add.activeForm } : {}),
			...(add.note !== undefined ? { note: add.note } : {}),
		})
	}
	return { kind: "projected", todos: kept }
}

/** True when raw tool-call input is a pure confirm call — the gate treats
 *  these exactly like the retired confirm_todos (never blocked, never an
 *  admitted-revision write). Unlike projectTodoCall an empty `todos` array
 *  counts as absent here (mode-mixing is rejected inside the tool, never at
 *  the gate); the remaining edit fields mirror its presence semantics. */
export function isTodoConfirmInput(input: unknown): boolean {
	if (!input || typeof input !== "object") return false
	const args = input as Record<string, unknown>
	const absent = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0)
	return (
		typeof args.confirm === "number" &&
		absent(args.todos) &&
		absent(args.update) &&
		absent(args.add) &&
		absent(args.remove)
	)
}

/** Marker on confirm-call result details so the execution-end hook can tell
 *  a confirm apart from a write without parsing args. Failed confirms carry
 *  { failed: true } (never null) — a confirm made no store change whatever
 *  its outcome, and the guard must trip either way. */
export interface TodoConfirmDetails {
	schemaVersion: number
	scope: TodoScope
	todos: readonly TodoItem[]
	confirm: true
	inputRevision: number
	failed?: true
}

/** Marker for a confirm attempt that did not close anything (stale revision
 *  or malformed payload): full shape, flagged failed. */
function failedConfirmDetails(
	scope: TodoScope,
	todos: readonly TodoItem[],
	attemptedRevision: number,
): TodoConfirmDetails {
	return {
		schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
		scope,
		todos,
		confirm: true,
		inputRevision: attemptedRevision,
		failed: true,
	}
}

export function isTodoConfirmResult(details: unknown): boolean {
	return !!details && typeof details === "object" && (details as { confirm?: unknown }).confirm === true
}

/** True when a full-list write would store exactly the current list.
 *  Drafts with ids match their stored item by id (storage is canonicalized
 *  id-sorted, so a reorder of id-bearing drafts is a genuine no-op); drafts
 *  without ids match positionally. Optional fields the model cannot see in
 *  state injection (activeForm, note) follow "omitted means keep". */
function isNoOpListWrite(incoming: WriteTodosParams["todos"], current: readonly TodoItem[]): boolean {
	if (incoming.length !== current.length) return false
	const ids = incoming.filter((draft) => typeof draft.id === "number").map((draft) => draft.id as number)
	// Duplicate ids: fall through to the reducer's structured error instead of
	// answering "already matches" for a malformed list.
	if (new Set(ids).size !== ids.length) return false
	const byId = new Map(current.map((todo) => [todo.id, todo]))
	// Id-bearing drafts claim their stored item; id-less drafts must not
	// positionally re-match a claimed item (two drafts, one stored item would
	// mask a real drop+recreate).
	const claimed = new Set(incoming.filter((draft) => typeof draft.id === "number").map((draft) => draft.id as number))
	const optionalMatches = (given: string | undefined, stored: string | undefined): boolean =>
		given === undefined || normalizeOptionalText(given) === stored
	return incoming.every((draft, index) => {
		const existing =
			typeof draft.id === "number"
				? byId.get(draft.id)
				: !claimed.has(current[index]?.id ?? Number.NaN) && normalizeText(draft.content) === current[index]?.content
					? current[index]
					: undefined
		if (!existing) return false
		return (
			normalizeText(draft.content) === existing.content &&
			(draft.status ?? "pending") === existing.status &&
			optionalMatches(draft.activeForm, existing.activeForm) &&
			optionalMatches(draft.note, existing.note)
		)
	})
}

/** Check whether a projection equals the current list (edit-mode no-op). */
function projectionsMatch(projected: readonly TodoDraft[], current: readonly TodoItem[]): boolean {
	const folded: WriteTodosParams["todos"] = projected.map((draft) => {
		// Strip the internal field before the store-semantics comparison —
		// carried through anyway (reducer + current both keep it).
		const { _syncKey: _ignored, ...rest } = draft as TodoDraft & { _syncKey?: string }
		return rest
	})
	return isNoOpListWrite(folded, current)
}

/** Replace-list args never carry back the fields the model cannot see in
 *  state injection (activeForm, note) or the stored-internal _syncKey, so a
 *  routine rewrite would silently wipe them. Merge them forward from the
 *  stored item for drafts that keep an existing id: omission preserves the
 *  stored value, an explicit value (including "") replaces it. Id-less
 *  drafts cannot be matched reliably, so they keep rename-and-clobber
 *  semantics — verbatim id-less rewrites are the no-op detector's job. */
function mergeDraftFieldsWithStored(
	drafts: WriteTodosParams["todos"],
	current: readonly TodoItem[],
): WriteTodosParams["todos"] {
	if (current.length === 0) return drafts
	const byId = new Map(current.map((todo) => [todo.id, todo]))
	let merged = false
	const result = drafts.map((draft) => {
		const existing = typeof draft.id === "number" ? byId.get(draft.id) : undefined
		if (!existing) return draft
		merged = true
		return {
			...draft,
			activeForm: draft.activeForm ?? existing.activeForm,
			note: draft.note ?? existing.note,
			_syncKey: existing._syncKey,
		}
	})
	return merged ? result : drafts
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

/** Real assistant writes reconcile their scope against the input revision
 *  delivered when the call was admitted (captured at the tool_call hook) —
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

async function executeTodos(
	toolCallId: string,
	params: TodosToolParams,
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
		const label = formatScopeLabel(scope)

		const projection = projectTodoCall(getTodosForScope(scope, sessionId), params)
		if (projection.kind === "invalid") {
			takeAdmittedInputRevision(sessionId, toolCallId)
			return { content: [{ type: "text" as const, text: projection.error }], details: null }
		}
		if (projection.kind === "confirm") {
			return executeConfirm(scope, projection.revision, sessionId, label)
		}
		if (projection.kind === "error") {
			// Bad ids in an edit: nothing touched the store. Consume the
			// admitted-revision bookkeeping; no write follows.
			takeAdmittedInputRevision(sessionId, toolCallId)
			return { content: [{ type: "text" as const, text: projection.error }], details: null }
		}

		if (params.todos !== undefined) {
			// Full-list path: unchanged rewrites churn nothing and do not count
			// as reconciliation — a check-in on an accurate list closes through
			// confirm, not through a rewrite.
			const current = getTodosForScope(scope, sessionId)
			const drafts = mergeDraftFieldsWithStored(params.todos, current)
			if (isNoOpListWrite(drafts, current)) {
				takeAdmittedInputRevision(sessionId, toolCallId)
				return {
					content: [
						{
							type: "text" as const,
							text: `The ${label} list already matches — no change made. To close a check-in on an unchanged list, call todos with {confirm: <input revision>}.`,
						},
					],
					details: null,
				}
			}
			const details = applyWriteTodos({ scope, todos: drafts }, sessionId, toolWriteContext(sessionId, toolCallId))
			// Name deletions: a full list is a replace, and an item the model
			// left out is gone — leave a trace it can act on next turn.
			const removed = current.filter((todo) => !details.todos.some((kept) => kept.id === todo.id))
			const removedNote = removed.length
				? ` Removed: ${removed.map((todo) => `#${todo.id} "${todo.content}"`).join(", ")}.`
				: ""
			return {
				content: [
					{
						type: "text" as const,
						text:
							details.todos.length === 0
								? `Cleared todos in ${label}.`
								: `Updated ${details.todos.length} todos in ${label}.${removedNote}`,
					},
				],
				details,
			}
		}

		// Edits path: validate and commit against one snapshot inside the
		// atomic mutation window so parallel calls compose instead of
		// last-writer-wins.
		const mutation = applyTodoMutation(
			scope,
			sessionId,
			(snapshot) => {
				const projected = projectTodoCall(snapshot, params)
				if (projected.kind !== "projected") {
					throw new Error("error" in projected ? projected.error : MODE_ERROR)
				}
				if (projectionsMatch(projected.todos, snapshot)) return undefined
				return projected.todos
			},
			toolWriteContext(sessionId, toolCallId),
		)
		if (!mutation) {
			return {
				content: [
					{
						type: "text" as const,
						text: `The ${label} list already matches — no change made. To close a check-in on an unchanged list, call todos with {confirm: <input revision>}.`,
					},
				],
				details: null,
			}
		}
		const summary = [
			params.remove?.length ? `removed ${params.remove.map((id) => `#${id}`).join(", ")}` : undefined,
			params.update?.length ? `updated ${params.update.map((edit) => `#${edit.id}`).join(", ")}` : undefined,
			params.add?.length ? `added ${params.add.length} item(s)` : undefined,
		]
			.filter(Boolean)
			.join(", ")
		return {
			content: [{ type: "text" as const, text: `Applied todo edits in ${label}: ${summary}.` }],
			details: mutation,
		}
	} catch (error) {
		return {
			content: [{ type: "text" as const, text: `Failed to write todos: ${todoErrorMessage(error)}` }],
			details: null,
		}
	}
}

/** Confirm an unchanged, accurate list: revision-only proof. Success
 *  records reconciliation without a store write; the gate closes via its
 *  own change notification. */
function executeConfirm(scope: TodoScope, revision: number, sessionId: string, label: string) {
	const todos = getTodosForScope(scope, sessionId)
	const currentRevision = getInputRevision(sessionId)
	if (!Number.isInteger(revision) || revision < 0) {
		return {
			content: [
				{
					type: "text" as const,
					text: `confirm expects the current input revision from the check-in instructions (a non-negative integer). Current revision: ${currentRevision}.`,
				},
			],
			details: failedConfirmDetails(scope, todos, revision),
		}
	}
	if (revision !== currentRevision) {
		reportConfirmMismatch(scope, sessionId, "stale_revision")
		return {
			content: [
				{
					type: "text" as const,
					text: `The accepted input revision is now ${currentRevision} (you confirmed ${revision}) — newer user input arrived after this confirmation was prepared. Reconcile the ${label} list against the latest direction, then confirm ${currentRevision}. Current list: ${renderTodoEntries(todos, { empty: "(the list is empty)", separator: "; " })}`,
				},
			],
			details: failedConfirmDetails(scope, todos, revision),
		}
	}
	recordScopeReconciliation(scope, sessionId, currentRevision)
	reconcileCheckinScope(scope, sessionId, currentRevision, "confirm")
	const details: TodoConfirmDetails = {
		schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
		scope,
		todos,
		confirm: true,
		inputRevision: currentRevision,
	}
	return {
		content: [
			{
				type: "text" as const,
				text: `Confirmed ${todos.length} todos in ${label} match the current plan (input revision ${currentRevision}).`,
			},
		],
		details,
	}
}

export function registerTodosTool(pi: ExtensionAPI): void {
	// Write results carry the store change; confirm results carry the
	// confirm marker. The gate keys on the marker via isTodoConfirmResult.
	pi.registerTool<typeof TODO_TOOL_PARAMETERS, WriteTodosDetails | TodoConfirmDetails | null>({
		name: TODOS_TOOL_NAME,
		label: "Todos",
		description:
			"Work the session todo list. For routine changes pass only what changes: `update` re-statuses or edits existing items by id, `add` appends new items, `remove` deletes items by id. Use the full `todos` array to create the list or deliberately replace it — every kept item must appear, omitted items are deleted. `confirm` closes a todo check-in on an unchanged list. Ids from state injection stay stable across edits.",
		promptSnippet: "Work the todo list (update/add/remove edits, full-list create, check-in confirm)",
		parameters: TODO_TOOL_PARAMETERS,
		// "parallel" stays: edits read-and-commit inside one synchronous
		// mutation window, so same-scope calls compose; full-list writes
		// against the same pre-state remain last-writer-wins by contract.
		executionMode: "parallel",
		execute: executeTodos,
	})
}
