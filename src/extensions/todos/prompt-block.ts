import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"

const TODO_GUIDANCE = `## Todos
For non-trivial work, maintain a todo list — it is a contract with the user, not just your own memory. Create one for multi-step work (code changes, debugging, reviews, investigations, multi-file tasks); start short (2-3 items) and grow it as the task structure emerges. Skip it for single-step answers or conversational exchanges. Todo tools track session plans only — they never authorize publishing externally, mutating remote state, or irreversible actions; those always need explicit user approval. Do not leave TODO placeholders in code unless explicitly requested.

Use mark_todo as the default for status changes, create_todos for the initial list, add_todo to append one item, update_todos only when the plan changes significantly, clear_todos when done. Mark the current item completed and the next in_progress as you work, and **always pair todo updates with the next work tool call in the same turn** — never a turn that is only a todo update. Keep at most one item in_progress, and preserve user-created todos and existing ids when updating. On a staleness warning, refresh the list at the next natural breakpoint alongside a work tool call — not on every turn.`

/** Static system-prompt block: the todo-usage guidance. Content is constant —
 *  live todo state is injected per-turn via the transient `context` event
 *  (`context-state.ts`), and the ferment-specific supplement lives in its own
 *  dynamic block (`ferment-prompt-block.ts`). This file must stay free of
 *  volatile-store imports; the cache-stability contract test enforces it. */
export function renderTodoPromptBlock(): string {
	return TODO_GUIDANCE
}

export function registerTodoPromptBlock(pi: ExtensionAPI): void {
	createSystemPromptBlocks(pi, "todos").register({
		id: "todo-guidance",
		render: renderTodoPromptBlock,
	})
}

export { renderTodoPromptBlock as __test_renderTodoPromptBlock }
