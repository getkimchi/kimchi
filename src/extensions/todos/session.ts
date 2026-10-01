import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { TODO_TOOL_NAMES } from "./tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type WriteTodosDetails } from "./types.js"

const TODO_TOOL_NAME_SET = new Set<string>(["write_todos", ...TODO_TOOL_NAMES])

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

export function isWriteTodosDetails(value: unknown): value is WriteTodosDetails {
	return (
		isRecord(value) &&
		value.schemaVersion === TODO_TOOL_RESULT_SCHEMA_VERSION &&
		value.scope !== undefined &&
		Array.isArray(value.todos)
	)
}

export function isTodoWriteToolName(toolName: string): boolean {
	return TODO_TOOL_NAME_SET.has(toolName)
}

export function getWriteTodosDetails(entry: SessionEntry): WriteTodosDetails | undefined {
	if (entry.type === "custom" && entry.customType === TODO_CUSTOM_ENTRY_TYPE) {
		return isWriteTodosDetails(entry.data) ? entry.data : undefined
	}

	if (entry.type !== "message") return undefined
	const message = entry.message as unknown
	if (!isRecord(message) || message.role !== "toolResult" || !isTodoWriteToolName(String(message.toolName))) {
		return undefined
	}
	return isWriteTodosDetails(message.details) ? message.details : undefined
}
