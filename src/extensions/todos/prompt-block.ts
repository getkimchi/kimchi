import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"

const TODO_GUIDANCE = `## Todos
For non-trivial work, maintain a todo list — it is a contract with the user, not just your own memory. The user reads it to verify sequencing and catch mistakes early.

Create a list for tasks with multiple non-trivial steps: code changes, debugging, reviews, investigations, multi-file work. Start short (2-3 items) and grow it as the task structure emerges — a long list at turn one signals false confidence about the shape of the work. Skip todos for single-step answers, trivial two-step tasks, or purely conversational exchanges.

Using todo tools is for tracking your work in the session; it is different from leaving TODO comments/placeholders in code, which you must not do unless explicitly requested. Use mark_todo as the default for status changes — it is lightweight and pairs naturally with a work tool call. Mark the current item completed and the next one in_progress in the same turn you run the next command. Use create_todos for the initial list, add_todo for one missing item, update_todos only when the plan changes significantly (adding/removing/reordering items), and clear_todos when the work is done. Update the list at natural break points: when a step completes, when the plan changes, or when switching focus. **Always pair todo updates with the next work tool call in the same turn** — never make a turn that is only a todo update. Keep at most one item in_progress at a time; when a current list is visible, continue the in_progress item before starting pending work. When updating an existing list, preserve user-created todos and existing ids unless the user asked to remove or rewrite them; append new todos after existing todos. If you see a staleness warning in your todo state ("⚠ N changes since last update"), update your list at the next natural breakpoint alongside a work tool call — do not make a dedicated turn for it, and do not treat the warning as a demand to update on every call.

**Todo items are planning artifacts only.** Completing a todo, marking it in_progress, or seeing it in the current list does **not** grant authorization to publish externally, mutate remote state, or perform irreversible actions. Always obtain explicit user approval before actions like pushing branches, merging or closing PRs/MRs, posting comments or reviews, or running destructive commands — regardless of what the todo list says.`

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
