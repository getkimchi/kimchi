import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getTurnsSinceStepTodoWrite } from "../ferment/todo-sync.js"
import { parseTodoScopeKey } from "./scope.js"
import { getTodoState, getToolCallsSinceTodoWrite, hasTodoListBeenUpdated } from "./store.js"
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

/**
 * Returns a graduated staleness indicator string based on the number of
 * non-todo tool calls since the last todo write. Returns `undefined` when
 * staleness is low enough not to warrant a warning.
 *
 * This replaces the old active nudge messages with passive state
 * enrichment — the model sees the warning in the state block it already
 * reads, and can choose to act on it at the next natural break point.
 */
function stalenessIndicator(changes: number): string | undefined {
	if (changes <= 2) return undefined
	if (changes <= 6) return `${changes} changes since last update — update alongside your next tool call`
	if (changes <= 11) return `⚠ ${changes} changes since last update — update alongside your next tool call now`
	return `⚠ ${changes} changes — list is significantly stale, update alongside your next tool call`
}

/** Render the current todo store as a markdown section. Returns `undefined`
 *  when there is nothing to show (no scopes at all).
 *
 *  This is volatile per-session state: it is consumed ONLY by the transient
 *  `context`-event path (`context-state.ts`), never by a system-prompt block.
 *  Keeping it here (rather than in `prompt-block.ts`) lets the cache-stability
 *  contract test hold the static todos registrar to a zero-volatile-imports
 *  standard — see system-prompt-stability.contract.test.ts. */
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

	// Collect all staleness signals to show the strongest one at the end.
	const stalenessWarnings: string[] = []

	if (global.length > 0) {
		const summary = formatProgressSummary(global)
		lines.push(`**Global**${summary ? ` (${summary})` : ""}`)
		for (const todo of global) lines.push(formatTodoLine(todo))
		lines.push("")

		// Global-scope staleness (from toolCallsSinceTodoWrite counter)
		const changes = getToolCallsSinceTodoWrite(sessionId)
		if (changes > 2 && !hasTodoListBeenUpdated(sessionId)) {
			// List was created but never updated — more urgent than generic staleness.
			stalenessWarnings.push(
				`⚠ List created but never updated — mark items as you complete them alongside your next tool call`,
			)
		} else {
			const globalStale = stalenessIndicator(changes)
			if (globalStale) stalenessWarnings.push(globalStale)
		}
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

	// Ferment stall detection: if a ferment step is running and the step-scope
	// todos haven't been updated in several turns, add a staleness warning.
	const staleTurns = getTurnsSinceStepTodoWrite(sessionId)
	if (staleTurns >= 5) {
		stalenessWarnings.push(
			`⚠ Step todos have not been updated for ${staleTurns} turns. If you are iterating without progress, step back and reassess your approach. Update your todo plan with what you have tried and what to try next.`,
		)
	}

	if (stalenessWarnings.length > 0) {
		lines.push("")
		for (const warning of stalenessWarnings) lines.push(warning)
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
