import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { parseTodoScopeKey } from "./scope.js"
import { getTodoState } from "./store.js"
import type { TodoItem, TodoScope, TodoStatus } from "./types.js"

function statusGlyph(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "✓"
		case "in_progress":
			return "▶"
		case "blocked":
			return "!"
		case "pending":
			return "○"
		default:
			return "○"
	}
}

function formatTodoLine(todo: TodoItem): string {
	return `- ${statusGlyph(todo.status)} ${todo.content}`
}

/** Render a compact progress summary, e.g. "1/3 done · 2 active · 1 blocked". */
function formatProgressSummary(todos: TodoItem[]): string {
	const total = todos.length
	if (total === 0) return ""
	const completed = todos.filter((t) => t.status === "completed").length
	const active = todos.filter((t) => t.status === "pending" || t.status === "in_progress").length
	const blocked = todos.filter((t) => t.status === "blocked").length
	const parts = [`${completed}/${total} done`, `${active} active`]
	if (blocked > 0) parts.push(`${blocked} blocked`)
	return parts.join(" · ")
}

/** Render the current todo store as a markdown section. Returns `undefined`
 *  when there is nothing to show (no scopes at all).
 *
 *  This is a PURE function of the todo store: no counters, no time. Persisted
 *  todo-state blocks are cached by prefix, so two renders of the same store
 *  must be byte-identical. Staleness/stall pressure is delivered separately
 *  as bounded one-shot steers — see staleness-steers.ts (todo writes) and
 *  ferment/todo-sync.ts (step stall).
 *
 *  The renderer lives outside any registrar file so the static import guard
 *  in the cache-stability contract test can be strict (zero allowlisted
 *  exceptions) — see system-prompt-stability.contract.test.ts. */
export function renderTodoStateMarkdown(sessionId: string): string | undefined {
	const state = getTodoState(sessionId)
	const scopeKeys = Object.keys(state.byScope)
	if (scopeKeys.length === 0) return undefined

	const global: TodoItem[] = []
	const fermentScopes: Array<{ phaseId: string; header: TodoItem; steps: TodoItem[] }> = []
	const stepScopes: Array<{ phaseId: string; stepId: string; todos: TodoItem[] }> = []

	for (const scopeKey of scopeKeys) {
		let scope: TodoScope | undefined
		try {
			scope = parseTodoScopeKey(scopeKey)
		} catch {
			continue
		}
		const scopeState = state.byScope[scopeKey]
		if (!scopeState) continue

		if (scope.kind === "global") {
			global.push(...scopeState.todos)
			continue
		}

		if (scope.kind === "ferment") {
			const todos = [...scopeState.todos].sort((a, b) => a.id - b.id)
			const header = todos.shift()
			if (!header) continue
			fermentScopes.push({ phaseId: scope.phaseId, header, steps: todos })
			continue
		}

		if (scope.kind === "ferment-step") {
			stepScopes.push({
				phaseId: scope.phaseId,
				stepId: scope.stepId,
				todos: [...scopeState.todos].sort((a, b) => a.id - b.id),
			})
		}
	}

	const lines: string[] = []
	lines.push("## Current Todos")
	lines.push("")

	if (global.length > 0) {
		const summary = formatProgressSummary(global)
		lines.push(`**Global**${summary ? ` (${summary})` : ""}`)
		for (const todo of global) lines.push(formatTodoLine(todo))
		lines.push("")
	}

	for (const phase of fermentScopes) {
		const allPhaseTodos = [phase.header, ...phase.steps]
		const summary = formatProgressSummary(allPhaseTodos)
		// Phase header: show content directly (already prefixed with `[Phase N]`).
		lines.push(`**${phase.header.content}**${summary ? ` (${summary})` : ""}`)
		for (const step of phase.steps) lines.push(formatTodoLine(step))
		lines.push("")
	}

	for (const stepScope of stepScopes) {
		const summary = formatProgressSummary(stepScope.todos)
		lines.push(`**Step ${stepScope.phaseId}/${stepScope.stepId}**${summary ? ` (${summary})` : ""}`)
		for (const todo of stepScope.todos) lines.push(formatTodoLine(todo))
		lines.push("")
	}

	// Trim trailing blank line for cleanliness.
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
	return lines.join("\n")
}

/** Renders the todo state markdown for the given context's session. Use this
 *  in tests to validate the complete path rather than calling the renderer
 *  with a session id directly. */
export function renderTodoStateBlock(ctx: ExtensionContext): string | undefined {
	return renderTodoStateMarkdown(ctx.sessionManager.getSessionId())
}

export { renderTodoStateMarkdown as __test_renderTodoStateMarkdown }
