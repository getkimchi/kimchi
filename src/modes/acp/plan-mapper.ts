/**
 * Maps todos-store writes to ACP `plan` session updates (stable v1 schema).
 *
 * ACP plan updates are full-list snapshots — the client replaces its plan on
 * every update. `PlanEntryStatus` in stable v1 has no `failed` variant, so a
 * blocked todo maps to `pending` with a `[blocked]` marker (and its `note`
 * appended).
 *
 * Internal todo fields (`id`, `_syncKey`) never leak into entries; the scope is
 * carried on `Plan._meta["kimchi.dev"].scope`, which spec-compliant clients
 * ignore.
 */

import type { Plan, PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk"
import type { TodoItem, WriteTodosDetails } from "../../extensions/todos/types.js"

const BLOCKED_MARKER = "[blocked]"

function todoToPlanEntry(todo: TodoItem): PlanEntry {
	if (todo.status === "blocked") {
		return {
			content: `${BLOCKED_MARKER} ${todo.content}${todo.note ? ` — ${todo.note}` : ""}`,
			priority: "medium",
			status: "pending",
		}
	}
	return {
		content: todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content,
		priority: "medium",
		status: todo.status,
	}
}

export function buildPlanEntries(todos: TodoItem[]): PlanEntry[] {
	return todos.map(todoToPlanEntry)
}

export function buildPlanUpdate(details: WriteTodosDetails): SessionUpdate {
	const plan: Plan = {
		entries: buildPlanEntries(details.todos),
		_meta: { "kimchi.dev": { scope: details.scope } },
	}
	return { ...plan, sessionUpdate: "plan" }
}
