import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { markHarnessSteer } from "../steer-marker.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { registerTodoStatePersistence } from "./context-state.js"
import { registerFermentTodoPromptBlock } from "./ferment-prompt-block.js"
import { registerTodoPromptBlock } from "./prompt-block.js"
import { getWriteTodosDetails, isTodoWriteToolName } from "./session.js"
import {
	createThresholdSteerTracker,
	sendHiddenSteer,
	stalenessIndicator,
	TODO_STALENESS_CUSTOM_TYPE,
	TODO_STALENESS_THRESHOLDS,
} from "./staleness-steers.js"
import {
	bumpToolCallsSinceTodoWrite,
	bumpWorkToolCalls,
	getTodosForScope,
	getToolCallsSinceTodoWrite,
	getWorkToolCalls,
	hasEverHadTodos,
	hasTodoNudgeFired,
	markTodoNudgeFired,
	resetToolCallsSinceTodoWrite,
	resolveTodoScope,
	restoreTodoStoreFromDetails,
	subscribeTodoStore,
} from "./store.js"
import { registerTodosTool } from "./tool.js"
import {
	disposeTodoWidget,
	ensureTodoWidget,
	registerTodoShortcut,
	resetTodoWidgetState,
	syncTodoWidget,
} from "./widget.js"

export * from "./command.js"
export * from "./constants.js"
export * from "./ferment-prompt-block.js"
export * from "./prompt-block.js"
export * from "./reducer.js"
export * from "./staleness-steers.js"
export * from "./state-markdown.js"
export * from "./store.js"
export * from "./tool.js"
export * from "./types.js"
export * from "./widget.js"

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
}

function restoreTodoStoreFromSessionEntries(sessionManager: Pick<SessionManager, "getBranch" | "getSessionId">): void {
	const sessionId = sessionManager.getSessionId()
	restoreTodoStoreFromDetails(
		sessionManager
			.getBranch()
			.map(getWriteTodosDetails)
			.filter((details) => details !== undefined),
		sessionId,
	)
}

export const TODO_EARLY_NUDGE_THRESHOLD = 5

const TODO_EARLY_NUDGE_MESSAGE = markHarnessSteer(
	"You are working on a multi-step task without a todo list. Consider creating one to plan your approach — pair the create_todos call with your next work tool call in the same turn.",
)

function hiddenTodoMessage(text: string) {
	return {
		customType: TODO_CUSTOM_ENTRY_TYPE,
		content: [{ type: "text" as const, text }],
		display: false,
		details: { reason: "early_nudge" },
	}
}

export default function todosExtension(pi: ExtensionAPI): void {
	registerTodosTool(pi)
	registerTodoPromptBlock(pi)
	registerFermentTodoPromptBlock(pi)

	registerTodoStatePersistence(pi)

	// No `before_agent_start` fallback appending the guidance block is
	// registered here, on purpose: prompt-enrichment (registered earlier in
	// cli.ts) rebuilds the prompt on every turn via buildSystemPrompt, which
	// always includes this session's todo-guidance block. A silent patch
	// handler would mask a block-pipeline regression that the cache-stability
	// contract tests are designed to catch.

	if (isAgentWorker()) return

	registerTodosCommand(pi)
	registerTodoShortcut(pi)

	const _activeSessionContexts = new Map<string, ExtensionContext>()
	let unsubscribeTodoStore: (() => void) | undefined

	// One-shot staleness steers: fires once per threshold per write-epoch,
	// reset whenever the todo store is written (the subscribeTodoStore
	// listener below resets both the counter and this tracker).
	const stalenessTracker = createThresholdSteerTracker()

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

		resetTodoWidgetState(ctx)
		ensureTodoWidget(ctx)

		unsubscribeTodoStore?.()
		unsubscribeTodoStore = subscribeTodoStore((_, emitterSessionId) => {
			resetToolCallsSinceTodoWrite(emitterSessionId)
			stalenessTracker.reset(emitterSessionId)
			const sessionCtx = getSessionContext(emitterSessionId)
			if (sessionCtx) syncTodoWidget(sessionCtx)
		})

		replayAndSync(ctx)
	})

	pi.on("session_tree", (_event, ctx) => {
		replayAndSync(ctx)
	})

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.isError || isTodoWriteToolName(event.toolName)) return
		const sessionId = ctx.sessionManager.getSessionId()

		// Always count non-todo tool calls for the one-shot early nudge —
		// it tracks work done without a todo list, so it must increment even
		// when no todos exist (opposite of the staleness counter below).
		bumpWorkToolCalls(sessionId)

		// One-shot early nudge: if the session has done several non-todo tool
		// calls and never created a todo list, send a single hidden message
		// suggesting the model create one. Fires once per session, never recurs.
		if (!hasEverHadTodos(sessionId) && !hasTodoNudgeFired(sessionId)) {
			const count = getWorkToolCalls(sessionId)
			if (count >= TODO_EARLY_NUDGE_THRESHOLD) {
				markTodoNudgeFired(sessionId)
				pi.sendMessage(hiddenTodoMessage(TODO_EARLY_NUDGE_MESSAGE), { deliverAs: "steer" })
			}
		}

		// Only track staleness when there are existing todos to keep in sync.
		const scope = resolveTodoScope()
		if (getTodosForScope(scope, sessionId).length === 0) return

		bumpToolCallsSinceTodoWrite(sessionId)

		// Staleness pressure as bounded one-shot steers, not as volatile text
		// inside the persisted state block (which must stay byte-identical
		// between real writes for prefix-cache stability).
		const changes = getToolCallsSinceTodoWrite(sessionId)
		stalenessTracker.fireCrossed({
			sessionId,
			count: changes,
			thresholds: TODO_STALENESS_THRESHOLDS,
			send: (threshold) => {
				const text = stalenessIndicator(changes)
				if (text) sendHiddenSteer(pi, TODO_STALENESS_CUSTOM_TYPE, text, { reason: "staleness", threshold })
			},
		})
	})

	pi.on("turn_end", (event, ctx) => {
		// Sync the widget on terminal turns but do NOT force reconciliation.
		// The model updates todos on its own schedule guided by the system
		// prompt and the one-shot staleness steers.
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
