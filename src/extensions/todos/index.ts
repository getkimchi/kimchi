import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { appendTodoPromptBlockIfMissing, registerTodoPromptBlock } from "./prompt-block.js"
import { getTodosForScope, restoreTodoStoreFromDetails, subscribeTodoStore } from "./store.js"
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

export const TODO_CLEANUP_MESSAGE =
	"Your session todo list is complete but still open. If you are no longer working on these todos and everything is finished, call clear_todos to clear the list. If there is more to do, add the next items with add_todo instead. Do not leave a finished todo list lingering. This todo bookkeeping is internal; do not tell the user you are clearing or updating todos."

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

const TODO_REPLAY_TOOL_NAME_SET = new Set<string>([...TODO_TOOL_NAMES, "write_todos"])

function getWriteTodosDetails(entry: SessionEntry): WriteTodosDetails | undefined {
	if (entry.type === "custom" && entry.customType === TODO_CUSTOM_ENTRY_TYPE) {
		return isWriteTodosDetails(entry.data) ? entry.data : undefined
	}

	if (entry.type === "message") {
		const message = entry.message as unknown
		if (!isRecord(message)) return undefined
		if (message.role !== "toolResult" || !TODO_REPLAY_TOOL_NAME_SET.has(String(message.toolName))) return undefined
		return isWriteTodosDetails(message.details) ? message.details : undefined
	}

	return undefined
}

export function restoreTodoStoreFromSessionEntries(entries: readonly SessionEntry[]): void {
	restoreTodoStoreFromDetails(entries.map(getWriteTodosDetails).filter((details) => details !== undefined))
}

function completedTodosKey(): string | undefined {
	const todos = getTodosForScope()
	if (todos.length === 0 || todos.some((todo) => todo.status !== "completed")) return undefined
	return todos.map((todo) => `${todo.id}:${todo.content}`).join("|")
}

export default function todosExtension(pi: ExtensionAPI): void {
	registerTodosTool(pi)
	registerTodoPromptBlock(pi)
	pi.on("before_agent_start", (event) => {
		const systemPrompt = appendTodoPromptBlockIfMissing(event.systemPrompt)
		return systemPrompt ? { systemPrompt } : undefined
	})

	if (isAgentWorker()) return

	let latestCtx: ExtensionContext | undefined
	let unsubscribeTodoStore: (() => void) | undefined
	let cleanupSteeredTodosKey: string | undefined

	const maybeSteerCompletedTodosCleanup = () => {
		const key = completedTodosKey()
		if (!key) {
			cleanupSteeredTodosKey = undefined
			return
		}
		if (cleanupSteeredTodosKey === key) return
		cleanupSteeredTodosKey = key
		pi.sendMessage(
			{
				customType: TODO_CUSTOM_ENTRY_TYPE,
				content: [{ type: "text", text: TODO_CLEANUP_MESSAGE }],
				display: false,
				details: { reason: "completed_todos" },
			},
			{ deliverAs: "nextTurn" },
		)
	}

	registerTodosCommand(pi)
	registerTodoShortcut(pi)

	const replayAndSync = (ctx: ExtensionContext) => {
		latestCtx = ctx
		restoreTodoStoreFromSessionEntries(ctx.sessionManager.getBranch())
		syncTodoWidget(ctx)
	}

	pi.on("session_start", (_event, ctx) => {
		cleanupSteeredTodosKey = undefined
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

	pi.on("agent_end", () => {
		maybeSteerCompletedTodosCleanup()
	})

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = undefined
		latestCtx = undefined
		disposeTodoWidget(ctx)
	})
}
