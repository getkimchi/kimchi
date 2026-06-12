import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { GLOBAL_TODO_SCOPE, getTodosForScope } from "./store.js"

const TODO_GUIDANCE =
	"## Todos\nUse write_todos for multi-step work. Do not use write_todos for a single straightforward or purely conversational task. Keep the list tactical and update it after meaningful progress. Keep at most one item in_progress when possible; when a current list is visible, continue the in_progress item before starting pending work. When updating an existing list, preserve user-created todos and existing ids unless the user asked to remove or rewrite them; append new todos after existing todos."

export function renderTodoPromptBlock(): string {
	const todos = getTodosForScope(GLOBAL_TODO_SCOPE)
	if (todos.length === 0) return TODO_GUIDANCE

	const currentTodos = todos.map((todo) => `- #${todo.id} [${todo.status}] ${todo.content}`).join("\n")
	return `${TODO_GUIDANCE}\n\nCurrent global todos:\n${currentTodos}`
}

export function registerTodoPromptBlock(pi: ExtensionAPI): void {
	createSystemPromptBlocks(pi, "todos").register({
		id: "todo-guidance",
		render: renderTodoPromptBlock,
	})
}

export { renderTodoPromptBlock as __test_renderTodoPromptBlock }
