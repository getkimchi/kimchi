import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getActive } from "../ferment/state.js"
import { getTurnsSinceStepTodoWrite } from "../ferment/todo-sync.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { parseTodoScopeKey } from "./scope.js"
import { getTodoState } from "./store.js"
import type { TodoItem, TodoScope, TodoStatus } from "./types.js"

const TODO_GUIDANCE =
	"## Todos\nFor any non-trivial task, maintain a todo list. This includes code changes, debugging, reviews, investigations, multi-file reads, or anything with more than one meaningful step. Skip todos only for a single straightforward answer or a purely conversational task. Using todo tools is for tracking your work in the session; it is different from leaving TODO comments/placeholders in code, which you must not do unless explicitly requested. Use create_todos for the initial list before starting multi-step work, add_todo for one missing item, mark_todo for one status change, update_todos for batch replacement, and clear_todos only when the work is done or obsolete. Keep the list tactical and update it after meaningful progress, before switching to the next item, and before your final response. Keep at most one item in_progress when possible; when a current list is visible, continue the in_progress item before starting pending work. When updating an existing list, preserve user-created todos and existing ids unless the user asked to remove or rewrite them; append new todos after existing todos."

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

// ─── Live todo state for headless / one-shot runs ─────────────────────────────
// In interactive sessions the todo widget renders the current state. In
// headless runs there is no widget, so we surface the same state as a markdown
// block injected into the system prompt. The block self-gates: when the UI is
// present it returns undefined (no duplication), and when the store is empty
// it also returns undefined (no prompt pollution).

/** Module-level mirror of `ctx.hasUI` for the active session. Set by
 *  `todosExtension` from `session_start`, cleared on `session_shutdown`.
 *  Defaults to `true` so that pre-session renders (e.g. in tests) safely skip
 *  rather than injecting headless-only content into an interactive prompt. */
export let currentSessionHasUI = true

export function setCurrentSessionHasUI(value: boolean): void {
	currentSessionHasUI = value
}

function statusGlyph(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "[x]"
		case "in_progress":
			return "[~]"
		case "blocked":
			return "[!]"
		case "pending":
			return "[ ]"
		default:
			return "[ ]"
	}
}

function formatTodoLine(todo: TodoItem): string {
	return `- ${statusGlyph(todo.status)} ${todo.content}`
}

/** Render the current todo store as a markdown section suitable for injection
 *  into the system prompt. Returns `undefined` when there is nothing to show
 *  (no scopes at all) so the block pipeline skips it. */
export function renderTodoStateMarkdown(): string | undefined {
	const state = getTodoState()
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
		lines.push("**Global**")
		for (const todo of global) lines.push(formatTodoLine(todo))
		lines.push("")
	}

	for (const phase of fermentScopes) {
		// Phase header: show content directly (already prefixed with `[Phase N]`).
		lines.push(`**${phase.header.content}**`)
		for (const step of phase.steps) lines.push(formatTodoLine(step))
		lines.push("")
	}

	for (const stepScope of stepScopes) {
		lines.push(`**Step ${stepScope.phaseId}/${stepScope.stepId}**`)
		for (const todo of stepScope.todos) lines.push(formatTodoLine(todo))
		lines.push("")
	}

	// Stall detection: if a ferment step is running and the step-scope
	// todos haven't been updated in several turns, nudge the model.
	const staleTurns = getTurnsSinceStepTodoWrite()
	if (staleTurns >= 5) {
		lines.push("")
		lines.push(
			`\u26a0 Step todos have not been updated for ${staleTurns} turns. If you are iterating without progress, step back and reassess your approach. Update your todo plan with what you have tried and what to try next.`,
		)
	}

	// Trim trailing blank line for cleanliness.
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
	return lines.join("\n")
}

/** Register the live-state block. Self-gates:
 *  - returns `undefined` when the active session has a UI (widget handles it)
 *  - returns `undefined` when the store is empty
 *  Both cases let the existing prompt-block pipeline skip cleanly. */
export function registerTodoStateBlock(pi: ExtensionAPI): void {
	createSystemPromptBlocks(pi, "todos").register({
		id: "todo-state",
		render: () => {
			if (currentSessionHasUI) return undefined
			return renderTodoStateMarkdown()
		},
	})
}

/** Applies the full gate (currentSessionHasUI check) exactly as the registered
 *  system-prompt block does. Use this in tests to validate the complete path
 *  rather than calling the raw renderer directly. */
export function renderTodoStateBlock(): string | undefined {
	if (currentSessionHasUI) return undefined
	return renderTodoStateMarkdown()
}

export {
	renderTodoPromptBlock as __test_renderTodoPromptBlock,
	renderTodoStateMarkdown as __test_renderTodoStateMarkdown,
}
