import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { appendTodoPromptBlockIfMissing, registerTodoPromptBlock, registerTodoStateBlock } from "./prompt-block.js"
import { getTodosForScope, resolveTodoScope, restoreTodoStoreFromDetails, subscribeTodoStore } from "./store.js"
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

export const TODO_RECONCILE_MESSAGE =
	"Internal hidden todo checkpoint. You are about to stop while the session todo list still needs reconciliation. You must use the todo tools before any user-facing wrap-up. Make the list match reality: mark completed work completed; keep real remaining work pending/in_progress; mark blocked work blocked; clear obsolete or fully done lists. If work is impossible, unavailable, or cannot proceed now, mark it blocked instead of continuing indefinitely. Do not tell the user about this checkpoint or mention that you are clearing or updating todos."
export const TODO_CHECKPOINT_MESSAGE =
	"Internal hidden todo checkpoint. You changed state since the session todo list was last updated. You must use the todo tools before switching tasks or answering finally. Make the list match reality: mark completed work completed; keep real remaining work pending/in_progress; mark blocked work blocked; clear obsolete or fully done lists. If work is impossible, unavailable, or cannot proceed now, mark it blocked instead of continuing indefinitely. Do not tell the user about this checkpoint or mention that you are clearing or updating todos."

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

/**
 * Checks whether any todo tool is currently available to the model.
 *
 * Other extensions (e.g. ferment plan review) suppress ALL tools via
 * `pi.setActiveTools([])`. In that state the model cannot reconcile todos —
 * sending `reconcile_todos` follow-ups or `todo_checkpoint` context messages
 * would create an infinite loop: the model tries to call todo tools, fails
 * (tools unavailable), produces text-only output, `turn_end` fires, and the
 * checkpoint fires again because `workSinceTodoWrite` was never cleared.
 */
function anyTodoToolsAvailable(pi: ExtensionAPI): boolean {
	const active = pi.getActiveTools()
	return TODO_TOOL_NAMES.some((name) => active.includes(name))
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

function restoreTodoStoreFromSessionEntries(sessionManager: Pick<SessionManager, "getBranch" | "getSessionId">): void {
	const sessionId = sessionManager.getSessionId()
	const entries = sessionManager.getBranch()
	restoreTodoStoreFromDetails(
		entries.map(getWriteTodosDetails).filter((details) => details !== undefined),
		sessionId,
	)
}

function currentTodoStateKey(sessionId: string): string | undefined {
	const scope = resolveTodoScope()
	const todos = getTodosForScope(scope, sessionId)
	if (todos.length === 0) return undefined
	return JSON.stringify({ scope, todos: todos.map((todo) => [todo.id, todo.status, todo.content]) })
}

function currentTodoStateText(sessionId: string): string | undefined {
	const scope = resolveTodoScope()
	const todos = getTodosForScope(scope, sessionId)
	if (todos.length === 0) return undefined
	const scopeText = scope.kind === "global" ? "global" : JSON.stringify(scope)
	return [
		`Current todos (${scopeText}):`,
		...todos.map((todo) => `- #${todo.id} [${todo.status}] ${todo.content}`),
	].join("\n")
}

function hiddenTodoMessage(reason: string, text: string) {
	return {
		customType: TODO_CUSTOM_ENTRY_TYPE,
		content: [{ type: "text" as const, text }],
		display: false,
		details: { reason },
	}
}

function hasVisibleText(message: unknown): boolean {
	if (!isRecord(message)) return false
	const content = message.content
	if (!Array.isArray(content)) return false
	return content.some(
		(part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.trim(),
	)
}

function isTerminalAssistantTurn(
	event: { message: unknown; toolResults: readonly unknown[] },
	ctx: ExtensionContext,
): boolean {
	if (event.toolResults.length > 0 || ctx.hasPendingMessages?.()) return false
	const message = event.message
	if (!isRecord(message) || message.role !== "assistant") return false
	return message.stopReason !== "aborted" && message.stopReason !== "error"
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

	const _workSinceTodoWrite = new Map<string, boolean>()
	const _activeSessionContexts = new Map<string, ExtensionContext>()
	let unsubscribeTodoStore: (() => void) | undefined

	function setWorkSinceTodoWrite(sessionId: string, value: boolean): void {
		_workSinceTodoWrite.set(sessionId, value)
	}

	function getWorkSinceTodoWrite(sessionId: string): boolean {
		return _workSinceTodoWrite.get(sessionId) ?? false
	}

	function setSessionContext(sessionId: string, ctx: ExtensionContext): void {
		_activeSessionContexts.set(sessionId, ctx)
	}

	function getSessionContext(sessionId: string): ExtensionContext | undefined {
		return _activeSessionContexts.get(sessionId)
	}

	function deleteSessionContext(sessionId: string): void {
		_activeSessionContexts.delete(sessionId)
	}

	const maybeSteerTodoReconciliation = (message: unknown, ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId()

		if (!getWorkSinceTodoWrite(sessionId)) return
		if (!hasVisibleText(message)) return
		// If the model has no todo tools available (e.g. during a ferment plan
		// review where all tools are suppressed), it cannot reconcile todos.
		// Sending a follow-up would trap it in a text-only loop. Reset the flag
		// and defer reconciliation until tools are restored.
		if (!anyTodoToolsAvailable(pi)) {
			setWorkSinceTodoWrite(sessionId, false)
			return
		}
		if (!currentTodoStateKey(sessionId)) {
			setWorkSinceTodoWrite(sessionId, false)
			return
		}
		const stateText = currentTodoStateText(sessionId)
		const promptText = stateText ? `${TODO_RECONCILE_MESSAGE}\n\n${stateText}` : TODO_RECONCILE_MESSAGE
		pi.sendMessage(hiddenTodoMessage("reconcile_todos", promptText), { deliverAs: "followUp" })
	}

	const replayAndSync = (ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId()

		restoreTodoStoreFromSessionEntries(ctx.sessionManager)
		setWorkSinceTodoWrite(sessionId, false)
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
			setWorkSinceTodoWrite(emitterSessionId, false)
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
		if (currentTodoStateKey(sessionId)) {
			setWorkSinceTodoWrite(sessionId, true)
		}
	})

	pi.on("context", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId()

		if (!getWorkSinceTodoWrite(sessionId)) return undefined
		// Same guard as maybeSteerTodoReconciliation: if todo tools are not
		// available (e.g. ferment plan review), skip checkpoint injection.
		if (!anyTodoToolsAvailable(pi)) return undefined
		const stateText = currentTodoStateText(sessionId)
		if (!stateText) return setWorkSinceTodoWrite(sessionId, false)
		return {
			messages: [
				...event.messages,
				{
					role: "custom" as const,
					...hiddenTodoMessage("todo_checkpoint", `${TODO_CHECKPOINT_MESSAGE}\n\n${stateText}`),
					timestamp: Date.now(),
				},
			],
		}
	})

	pi.on("turn_end", (event, ctx) => {
		if (!isTerminalAssistantTurn(event, ctx)) return
		syncTodoWidget(ctx)
		maybeSteerTodoReconciliation(event.message, ctx)
	})

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = undefined
		disposeTodoWidget(ctx)

		const sessionId = ctx.sessionManager.getSessionId()
		deleteSessionContext(sessionId)
	})
}
