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

export const TODO_STEER_MESSAGE =
	"Maintain session todos for this work. Call add_todo or update_todos with concrete tactical items before continuing; do not create TODO comments/placeholders in code."

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
const TODO_REPLAY_TOOL_NAME_SET = new Set<string>([...TODO_TOOL_NAMES, "write_todos"])
const TODO_STEER_EXEMPT_TOOL_NAME_SET = new Set<string>(["set_phase", "agent", "get_subagent_result", "steer_subagent"])

function hasOpenTodos(): boolean {
	return getTodosForScope().some((todo) => todo.status !== "completed")
}

export function shouldSteerForMissingTodos(toolName: string): boolean {
	const normalizedToolName = toolName.toLowerCase()
	if (TODO_TOOL_NAME_SET.has(normalizedToolName)) return false
	if (TODO_STEER_EXEMPT_TOOL_NAME_SET.has(normalizedToolName)) return false
	if (hasOpenTodos()) return false
	return true
}

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

export default function todosExtension(pi: ExtensionAPI): void {
	registerTodosTool(pi)
	registerTodoPromptBlock(pi)
	pi.on("before_agent_start", (event) => {
		const systemPrompt = appendTodoPromptBlockIfMissing(event.systemPrompt)
		return systemPrompt ? { systemPrompt } : undefined
	})

	if (isAgentWorker()) return

	let missingTodoSteerSent = false

	pi.on("input", (event) => {
		if (event.source === "extension") return
		missingTodoSteerSent = false
	})

	pi.on("tool_call", (event) => {
		if (!event.toolName) return { block: false }
		if (!shouldSteerForMissingTodos(event.toolName)) {
			missingTodoSteerSent = false
			return { block: false }
		}
		if (!missingTodoSteerSent) {
			missingTodoSteerSent = true
			pi.sendMessage(
				{
					customType: TODO_CUSTOM_ENTRY_TYPE,
					content: [{ type: "text", text: TODO_STEER_MESSAGE }],
					display: false,
					details: { reason: "missing_todos" },
				},
				{ deliverAs: "steer", triggerTurn: false },
			)
		}
		return { block: false }
	})

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
		missingTodoSteerSent = false
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
