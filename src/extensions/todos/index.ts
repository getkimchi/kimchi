import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { registerTodoPromptBlock } from "./prompt-block.js"
import { restoreTodoStoreFromDetails, subscribeTodoStore } from "./store.js"
import { TODO_TOOL_NAMES, registerTodosTool } from "./tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type WriteTodosDetails } from "./types.js"
import {
	disposeTodoWidget,
	ensureTodoWidget,
	registerTodoShortcut,
	resetTodoWidgetState,
	syncTodoWidget,
} from "./widget.js"

export * from "./types.js"
export * from "./reducer.js"
export * from "./constants.js"
export * from "./store.js"
export * from "./tool.js"
export * from "./widget.js"
export * from "./command.js"
export * from "./prompt-block.js"

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function isWriteTodosDetails(value: unknown): value is WriteTodosDetails {
	return (
		isRecord(value) &&
		value.schemaVersion === TODO_TOOL_RESULT_SCHEMA_VERSION &&
		value.scope !== undefined &&
		Array.isArray(value.todos)
	)
}

const TODO_TOOL_NAME_SET = new Set<string>(TODO_TOOL_NAMES)

function getWriteTodosDetails(entry: SessionEntry): WriteTodosDetails | undefined {
	if (entry.type === "custom" && entry.customType === TODO_CUSTOM_ENTRY_TYPE) {
		return isWriteTodosDetails(entry.data) ? entry.data : undefined
	}

	if (entry.type === "message") {
		const message = entry.message as unknown
		if (!isRecord(message)) return undefined
		if (message.role !== "toolResult" || !TODO_TOOL_NAME_SET.has(String(message.toolName))) return undefined
		return isWriteTodosDetails(message.details) ? message.details : undefined
	}

	return undefined
}

export function restoreTodoStoreFromSessionEntries(entries: readonly SessionEntry[]): void {
	restoreTodoStoreFromDetails(entries.map(getWriteTodosDetails).filter((details) => details !== undefined))
}

export default function todosExtension(pi: ExtensionAPI): void {
	registerTodosTool(pi)
	registerTodoPromptBlock(pi)

	if (isAgentWorker()) return

	let latestCtx: ExtensionContext | undefined
	let unsubscribeTodoStore: (() => void) | undefined

	registerTodosCommand(pi)
	registerTodoShortcut(pi)

	const replayAndSync = (ctx: ExtensionContext) => {
		latestCtx = ctx
		restoreTodoStoreFromSessionEntries(ctx.sessionManager.getBranch())
		syncTodoWidget(ctx)
	}

	pi.on("session_start", (_event, ctx) => {
		resetTodoWidgetState()
		ensureTodoWidget(ctx)
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = subscribeTodoStore(() => {
			if (!latestCtx?.hasUI) return
			syncTodoWidget(latestCtx)
		})
		replayAndSync(ctx)
	})

	pi.on("session_tree", (_event, ctx) => {
		replayAndSync(ctx)
	})

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = undefined
		latestCtx = undefined
		disposeTodoWidget(ctx)
	})
}
