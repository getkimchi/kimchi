import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { applyWriteTodos } from "./store.js"
import type { WriteTodosParams } from "./types.js"

export const TODO_TOOL_NAME = "write_todos"

function todoErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export function registerTodosTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "Write Todos",
		description: "Replace the todo list for the current scope. Use for multi-step work.",
		promptSnippet: "Maintain a tactical todo list for multi-step work",
		parameters: Type.Object({
			scope: Type.Optional(Type.Any()),
			todos: Type.Array(
				Type.Object({
					id: Type.Optional(Type.Number()),
					content: Type.String(),
					status: Type.Union([
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("blocked"),
						Type.Literal("completed"),
					]),
					activeForm: Type.Optional(Type.String()),
					note: Type.Optional(Type.String()),
				}),
			),
		}),
		async execute(_toolCallId, params: WriteTodosParams) {
			try {
				const details = applyWriteTodos(params)
				return {
					content: [{ type: "text" as const, text: `Updated ${details.todos.length} todos.` }],
					details,
				}
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `Failed to write todos: ${todoErrorMessage(error)}` }],
					details: null,
				}
			}
		},
	})
}
