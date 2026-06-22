import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import {
	appendTodoPromptBlockIfMissing,
	registerTodoPromptBlock,
	registerTodoStateBlock,
	setCurrentSessionHasUI,
} from "./prompt-block.js"
import { getTodosForScope, resolveTodoScope, restoreTodoStoreFromDetails, subscribeTodoStore } from "./store.js"
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

export const TODO_RECONCILE_MESSAGE =
	"Internal hidden todo checkpoint. You are about to stop while the session todo list still needs reconciliation. Before any user-facing wrap-up, use the todo tools to make the list match reality: if an item is done, mark it completed; if work remains, keep working or mark the real pending/blocked state; if the list is obsolete or fully done, clear it. Do not tell the user about this checkpoint or mention that you are clearing or updating todos."
export const TODO_CHECKPOINT_MESSAGE =
	"Internal hidden todo checkpoint. You changed state since the session todo list was last updated. Before switching tasks or answering finally, reconcile the todo list: completed work should be marked completed, remaining work should stay pending/in_progress/blocked with the real next step, and obsolete or fully done lists should be cleared. Do not tell the user about this checkpoint or mention that you are clearing or updating todos."

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

function currentTodoStateKey(): string | undefined {
	const scope = resolveTodoScope()
	const todos = getTodosForScope(scope)
	if (todos.length === 0) return undefined
	return JSON.stringify({ scope, todos: todos.map((todo) => [todo.id, todo.status, todo.content]) })
}

function currentTodoStateText(): string | undefined {
	const scope = resolveTodoScope()
	const todos = getTodosForScope(scope)
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

	let latestCtx: ExtensionContext | undefined
	let unsubscribeTodoStore: (() => void) | undefined
	let workSinceTodoWrite = false
	let reconcileSteeredTodosKey: string | undefined

	const resetTodoProcessState = () => {
		workSinceTodoWrite = false
		reconcileSteeredTodosKey = undefined
	}

	const maybeSteerTodoReconciliation = () => {
		if (!workSinceTodoWrite) return
		const key = currentTodoStateKey()
		if (!key) {
			resetTodoProcessState()
			return
		}
		if (reconcileSteeredTodosKey === key) return
		reconcileSteeredTodosKey = key
		const stateText = currentTodoStateText()
		const message = stateText ? `${TODO_RECONCILE_MESSAGE}\n\n${stateText}` : TODO_RECONCILE_MESSAGE
		pi.sendMessage(hiddenTodoMessage("reconcile_todos", message), { deliverAs: "followUp" })
	}

	registerTodosCommand(pi)
	registerTodoShortcut(pi)
	// Headless (one-shot) runs have no widget; the todo-state prompt block
	// renders the same content as markdown so the orchestrator agent can see
	// it. Self-gates on currentSessionHasUI inside the block's render fn.
	registerTodoStateBlock(pi)

	const replayAndSync = (ctx: ExtensionContext) => {
		latestCtx = ctx
		restoreTodoStoreFromSessionEntries(ctx.sessionManager.getBranch())
		resetTodoProcessState()
		syncTodoWidget(ctx)
	}

	pi.on("session_start", (_event, ctx) => {
		resetTodoProcessState()
		resetTodoWidgetState()
		ensureTodoWidget(ctx)
		setCurrentSessionHasUI(ctx.hasUI)
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = subscribeTodoStore(() => {
			workSinceTodoWrite = false
			reconcileSteeredTodosKey = undefined
			if (!latestCtx?.hasUI) return
			syncTodoWidget(latestCtx)
		})
		replayAndSync(ctx)
	})

	pi.on("session_tree", (_event, ctx) => {
		replayAndSync(ctx)
	})

	pi.on("tool_execution_end", (event) => {
		if (event.isError || TODO_REPLAY_TOOL_NAME_SET.has(event.toolName)) return
		if (currentTodoStateKey()) workSinceTodoWrite = true
	})

	pi.on("context", (event) => {
		if (!workSinceTodoWrite) return undefined
		const stateText = currentTodoStateText()
		if (!stateText) {
			workSinceTodoWrite = false
			return undefined
		}
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
		maybeSteerTodoReconciliation()
	})

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = undefined
		latestCtx = undefined
		setCurrentSessionHasUI(true)
		disposeTodoWidget(ctx)
	})
}
