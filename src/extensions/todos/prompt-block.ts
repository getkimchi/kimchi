import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getActive } from "../ferment/state.js"
import { getTurnsSinceStepTodoWrite } from "../ferment/todo-sync.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { parseTodoScopeKey } from "./scope.js"
import { getTodoState, getToolCallsSinceTodoWrite, hasTodoListBeenUpdated } from "./store.js"
import type { TodoItem, TodoScope, TodoStatus } from "./types.js"

const TODO_GUIDANCE = `## Todos
For non-trivial work, maintain a todo list — it is a contract with the user, not just your own memory. The user reads it to verify sequencing and catch mistakes early.

Create a list for tasks with multiple non-trivial steps: code changes, debugging, reviews, investigations, multi-file work. Start short (2-3 items) and grow it as the task structure emerges — a long list at turn one signals false confidence about the shape of the work. Skip todos for single-step answers, trivial two-step tasks, or purely conversational exchanges.

Using todo tools is for tracking your work in the session; it is different from leaving TODO comments/placeholders in code, which you must not do unless explicitly requested. Use mark_todo as the default for status changes — it is lightweight and pairs naturally with a work tool call. Mark the current item completed and the next one in_progress in the same turn you run the next command. Use create_todos for the initial list, add_todo for one missing item, update_todos only when the plan changes significantly (adding/removing/reordering items), and clear_todos when the work is done. Update the list at natural break points: when a step completes, when the plan changes, or when switching focus. **Always pair todo updates with the next work tool call in the same turn** — never make a turn that is only a todo update. Keep at most one item in_progress at a time; when a current list is visible, continue the in_progress item before starting pending work. When updating an existing list, preserve user-created todos and existing ids unless the user asked to remove or rewrite them; append new todos after existing todos. If you see a staleness warning in your todo state ("⚠ N changes since last update"), update your list alongside your next tool call — do not make a dedicated turn for it.`

const FERMENT_TODO_GUIDANCE =
	"\n\nWhen working inside a ferment step, break the step into concrete sub-tasks using add_todo before writing code. Each sub-task should be a specific verifiable action (run a command, write a file, check an output). Mark each sub-task as you complete it rather than batch-replacing the entire list at the end."

export function renderTodoPromptBlock(): string {
	const ferment = getActive()
	if (ferment) return TODO_GUIDANCE + FERMENT_TODO_GUIDANCE
	return TODO_GUIDANCE
}

export function appendTodoPromptBlockIfMissing(systemPrompt: string): string | undefined {
	if (/(^|\n)## Todos(\n|$)/.test(systemPrompt)) return undefined
	return `${systemPrompt.trimEnd()}\n\n${renderTodoPromptBlock()}`
}

export function registerTodoPromptBlock(pi: ExtensionAPI): void {
	createSystemPromptBlocks(pi, "todos").register({
		id: "todo-guidance",
		render: renderTodoPromptBlock,
	})
}

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

/** Render the current todo store as a markdown section suitable for injection
 *  into the system prompt. Returns `undefined` when there is nothing to show
 *  (no scopes at all) so the block pipeline skips it. */
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

/** Register the live-state block. The block renders the current todo store
 *  as a markdown section in the system prompt so the model can see its own
 *  todos. This is independent of the TUI widget — the widget is for the user,
 *  the state block is for the model. Both render in TUI mode.
 *
 *  Returns `undefined` when the store is empty, letting the prompt-block
 *  pipeline skip cleanly. */
export function registerTodoStateBlock(pi: ExtensionAPI, ctx: ExtensionContext): void {
	createSystemPromptBlocks(pi, "todos").register({
		id: "todo-state",
		render: () => {
			const sessionId = ctx.sessionManager.getSessionId()
			return renderTodoStateMarkdown(sessionId)
		},
	})
}

/** Renders the todo state block exactly as the registered system-prompt block
 *  does. Use this in tests to validate the complete path rather than calling
 *  the raw renderer directly. */
export function renderTodoStateBlock(ctx: ExtensionContext): string | undefined {
	const sessionId = ctx.sessionManager.getSessionId()
	return renderTodoStateMarkdown(sessionId)
}

export {
	renderTodoPromptBlock as __test_renderTodoPromptBlock,
	renderTodoStateMarkdown as __test_renderTodoStateMarkdown,
}
