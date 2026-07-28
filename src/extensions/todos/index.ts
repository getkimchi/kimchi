import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { appendTodoPromptBlockIfMissing, registerTodoPromptBlock, registerTodoStateBlock } from "./prompt-block.js"
import {
	bumpToolCallsSinceTodoWrite,
	getTodosForScope,
	resetToolCallsSinceTodoWrite,
	resolveTodoScope,
	restoreTodoStoreFromDetails,
	subscribeTodoStore,
} from "./store.js"
import { registerTodosTool, TODO_TOOL_NAMES } from "./tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type WriteTodosDetails } from "./types.js"
import {
	disposeTodoWidget,
	ensureTodoWidget,
	registerTodoShortcut,
	resetTodoWidgetState,
	syncTodoWidget,
} from "./widget.js"

export * from "./command.js"
export * from "./constants.js"
export * from "./prompt-block.js"
export * from "./reducer.js"
export * from "./store.js"
export * from "./tool.js"
export * from "./types.js"
export * from "./widget.js"

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

function restoreTodoStoreFromSessionEntries(sessionManager: Pick<SessionManager, "getBranch" | "getSessionId">): void {
	const sessionId = sessionManager.getSessionId()
	const entries = sessionManager.getBranch()
	restoreTodoStoreFromDetails(
		entries.map(getWriteTodosDetails).filter((details) => details !== undefined),
		sessionId,
	)
}

export default function todosExtension(pi: ExtensionAPI): void {
	registerTodosTool(pi)
	registerTodoPromptBlock(pi)

	pi.on("before_agent_start", (event) => {
		const systemPrompt = appendTodoPromptBlockIfMissing(event.systemPrompt)
		return systemPrompt ? { systemPrompt } : undefined
	})

	if (isAgentWorker()) return

	registerTodosCommand(pi)
	registerTodoShortcut(pi)

	const _activeSessionContexts = new Map<string, ExtensionContext>()
	let unsubscribeTodoStore: (() => void) | undefined

	function setSessionContext(sessionId: string, ctx: ExtensionContext): void {
		_activeSessionContexts.set(sessionId, ctx)
	}

	function getSessionContext(sessionId: string): ExtensionContext | undefined {
		return _activeSessionContexts.get(sessionId)
	}

	function deleteSessionContext(sessionId: string): void {
		_activeSessionContexts.delete(sessionId)
	}

	const replayAndSync = (ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId()

		restoreTodoStoreFromSessionEntries(ctx.sessionManager)
		resetToolCallsSinceTodoWrite(sessionId)
		syncTodoWidget(ctx)
	}

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId()
		setSessionContext(sessionId, ctx)

		// Headless (one-shot) runs have no widget; the todo-state prompt block
		// renders the same content as markdown so the orchestrator agent can see
		// it. It receives the session context and self-gates on ctx.hasUI.
		registerTodoStateBlock(pi, ctx)

		resetTodoWidgetState(ctx)
		ensureTodoWidget(ctx)

		unsubscribeTodoStore?.()
		unsubscribeTodoStore = subscribeTodoStore((_, emitterSessionId) => {
			resetToolCallsSinceTodoWrite(emitterSessionId)
			const sessionCtx = getSessionContext(emitterSessionId)
			if (sessionCtx) syncTodoWidget(sessionCtx)
		})

		replayAndSync(ctx)
	})

	pi.on("session_tree", (_event, ctx) => {
		replayAndSync(ctx)
	})

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.isError || TODO_REPLAY_TOOL_NAME_SET.has(event.toolName)) return
		const sessionId = ctx.sessionManager.getSessionId()
		// Only track staleness when there are existing todos to keep in sync.
		const scope = resolveTodoScope()
		if (getTodosForScope(scope, sessionId).length > 0) {
			bumpToolCallsSinceTodoWrite(sessionId)
		}
	})

	pi.on("turn_end", (event, ctx) => {
		// Sync the widget on terminal turns but do NOT force reconciliation.
		// The model updates todos on its own schedule guided by the system
		// prompt and the passive staleness indicator in the state block.
		const message = event.message
		if (!isRecord(message) || message.role !== "assistant") return
		if ((event.toolResults as readonly unknown[]).length > 0 || ctx.hasPendingMessages?.()) return
		if (message.stopReason === "aborted" || message.stopReason === "error") return
		syncTodoWidget(ctx)
	})

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = undefined
		disposeTodoWidget(ctx)

		const sessionId = ctx.sessionManager.getSessionId()
		deleteSessionContext(sessionId)
	})
}
