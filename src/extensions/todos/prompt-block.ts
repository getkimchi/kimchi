import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"

const TODO_GUIDANCE = `## Todos
For non-trivial work, maintain a todo list — it is a contract with the user, not just your own memory. Create one for multi-step work (code changes, debugging, reviews, investigations, multi-file tasks); start short (2-3 items) and grow it as the task structure emerges. Skip it for single-step answers or conversational exchanges. Todo tools track session plans only — they never authorize publishing externally, mutating remote state, or irreversible actions; those always need explicit user approval. Do not leave TODO placeholders in code unless explicitly requested.

Use the todos tool for every list mutation. For routine changes pass only what changes — update to re-status or edit existing items by id, add for new items, remove for dropped items — and use the full todos array only to create the list or deliberately replace it, keeping existing ids and user-created todos. Mark the current item completed and the next in_progress as you work — at most one item in_progress — and pair todo updates with work tool calls when possible; todo-only updates are appropriate at wrap-up: close finished items and remove obsolete ones before the final answer. Preserve deferred, blocked, uncertain, and awaiting-approval work. When a check-in reminder asks you to reconcile, update the list or confirm it with todos, passing confirm set to the given input revision — rewriting an already-accurate list is a no-op and will not close the check. On a staleness warning, refresh the list at the next natural breakpoint alongside a work tool call, not on every turn.`

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
