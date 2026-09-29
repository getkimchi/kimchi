/**
 * Mirrors todo-store writes to ACP's stable-v1 `plan` session update.
 *
 * ACP plans are full-list replacements. Kimchi therefore publishes the most
 * specific non-empty Todo scope, independent of permission mode or Ferment
 * state, and falls back when a narrower scope is cleared.
 */

import type { Plan, PlanEntry, SessionNotification, SessionUpdate } from "@agentclientprotocol/sdk"
import { parseTodoScopeKey } from "../../extensions/todos/scope.js"
import { getTodoState, subscribeTodoStore } from "../../extensions/todos/store.js"
import type { TodoItem, TodoScope, WriteTodosDetails } from "../../extensions/todos/types.js"

type TodoPlanSnapshot = Pick<WriteTodosDetails, "scope" | "todos">

const TODO_SCOPE_SPECIFICITY: Record<TodoScope["kind"], number> = {
	"ferment-step": 2,
	ferment: 1,
	global: 0,
}

function todoToPlanEntry(todo: TodoItem): PlanEntry {
	if (todo.status === "blocked") {
		return {
			content: todo.content,
			priority: "medium",
			status: "pending",
			_meta: {
				"kimchi.dev": {
					todoStatus: "blocked",
					...(todo.note ? { note: todo.note } : {}),
				},
			},
		}
	}
	return {
		content: todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content,
		priority: "medium",
		status: todo.status,
	}
}

export function buildPlanEntries(todos: readonly TodoItem[]): PlanEntry[] {
	return todos.map(todoToPlanEntry)
}

export function buildPlanUpdate(details: TodoPlanSnapshot): SessionUpdate {
	const plan: Plan = {
		entries: buildPlanEntries(details.todos),
		_meta: { "kimchi.dev": { scope: details.scope } },
	}
	return { ...plan, sessionUpdate: "plan" }
}

/** Pick the Todo list ACP should currently display for this session. */
function currentPlanSnapshot(sessionId: string): TodoPlanSnapshot | undefined {
	const candidates = Object.entries(getTodoState(sessionId).byScope).filter(([, state]) => state.todos.length > 0)
	if (candidates.length === 0) return undefined
	candidates.sort(
		([left], [right]) =>
			TODO_SCOPE_SPECIFICITY[parseTodoScopeKey(right).kind] - TODO_SCOPE_SPECIFICITY[parseTodoScopeKey(left).kind],
	)
	const [scopeKey, state] = candidates[0]
	return { scope: parseTodoScopeKey(scopeKey), todos: state.todos }
}

export interface AcpPlanTrackerOptions {
	sessionId: string
	send: (notification: SessionNotification) => void
}

/** Session-scoped Todo subscription used by the ACP server. */
export class AcpPlanTracker {
	private lastUpdateJson: string | undefined
	private unsubscribe: (() => void) | undefined

	constructor(private readonly options: AcpPlanTrackerOptions) {}

	start(): void {
		if (this.unsubscribe) return
		this.unsubscribe = subscribeTodoStore((details, sessionId) => {
			if (sessionId !== this.options.sessionId) return
			this.send(currentPlanSnapshot(sessionId) ?? { scope: details.scope, todos: [] })
		})
	}

	stop(): void {
		this.unsubscribe?.()
		this.unsubscribe = undefined
		this.lastUpdateJson = undefined
	}

	emitRestoredSnapshot(): void {
		const snapshot = currentPlanSnapshot(this.options.sessionId)
		if (snapshot) this.send(snapshot)
	}

	private send(details: TodoPlanSnapshot): void {
		const update = buildPlanUpdate(details)
		const updateJson = JSON.stringify(update)
		if (updateJson === this.lastUpdateJson) return
		try {
			this.options.send({ sessionId: this.options.sessionId, update })
			this.lastUpdateJson = updateJson
		} catch (err) {
			console.error("[acp-plan] plan sessionUpdate send failed:", err)
		}
	}
}
