import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"

const TODO_GUIDANCE = `## Todos
For non-trivial multi-step work, track progress with the \`todos\` tool (actions: create, add, mark, clear; update replaces the whole list) — create a short list when the task structure emerges, and pair status updates with the next work tool call in the same turn. Todo tools track session plans only — they never authorize external/irreversible actions; skip todos for single-step exchanges.`

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
