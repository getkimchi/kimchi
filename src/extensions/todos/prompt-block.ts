import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"

const TODO_GUIDANCE =
	"## Todos\nFor any non-trivial task, maintain a todo list. This includes code changes, debugging, reviews, investigations, multi-file reads, or anything with more than one meaningful step. Skip todos only for a single straightforward answer or a purely conversational task. Using todo tools is for tracking your work in the session; it is different from leaving TODO comments/placeholders in code, which you must not do unless explicitly requested. Use add_todo for one missing item, mark_todo for one status change, update_todos for batch replacement, and clear_todos only when the work is done or obsolete. Keep the list tactical and update it after meaningful progress, before switching to the next item, and before your final response. Keep at most one item in_progress when possible; when a current list is visible, continue the in_progress item before starting pending work. When updating an existing list, preserve user-created todos and existing ids unless the user asked to remove or rewrite them; append new todos after existing todos."

export function renderTodoPromptBlock(): string {
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

export { renderTodoPromptBlock as __test_renderTodoPromptBlock }
