import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { FERMENT_V2_CUSTOM_ENTRY_TYPE } from "../ferment-v2/constants.js"
import { restoreFermentV2 } from "../ferment-v2/reducer.js"
import { FERMENT_V2_STATUS } from "../ferment-v2/types.js"
import { isAwaitingUserAnswer } from "../orchestration/continuation-nudge.js"
import { emitSteerFired, emitSteerOutcome, isSteerDisabled } from "../steer-events.js"
import { markHarnessSteer } from "../steer-marker.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CLOSURE_CUSTOM_TYPE, TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
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
import { TODO_STATUS } from "./types.js"
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

/** Compliance window (non-todo tool calls) after the early todo nudge
 *  during which adoption is measured (plan E.3). A todo write within the
 *  window = "complied"; window expiry without one = "repeated". */
export const EARLY_NUDGE_OUTCOME_WINDOW = 3

// Early-nudge outcome state: per-session work-call count captured when the
// nudge fired. Cleared on todo write (complied) or window expiry (repeated).
const earlyNudgeFiredAt = new Map<string, number>()

function markEarlyNudgeFired(sessionId: string, workCallCount: number): void {
	earlyNudgeFiredAt.set(sessionId, workCallCount)
}

function getEarlyNudgeFiredAt(sessionId: string): number | undefined {
	return earlyNudgeFiredAt.get(sessionId)
}

function clearEarlyNudgeFired(sessionId: string): void {
	earlyNudgeFiredAt.delete(sessionId)
}

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
		// The sibling maps in this extension follow the same cleanup site
		// (they leak the same way today) — clear the one this PR added so the
		// early-nudge bookkeeping can't leak across long-lived hosts.
		clearEarlyNudgeFired(sessionId)
	}

	const replayAndSync = (ctx: ExtensionContext) => {
		const sessionId = ctx.sessionManager.getSessionId()

		restoreTodoStoreFromSessionEntries(ctx.sessionManager)
		resetToolCallsSinceTodoWrite(sessionId)
		stalenessTracker.reset(sessionId)
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
		if (event.isError) return
		const sessionId = ctx.sessionManager.getSessionId()

		// A todo write within the nudge-outcome window = the model complied
		// with the early nudge.
		if (isTodoWriteToolName(event.toolName)) {
			if (getEarlyNudgeFiredAt(sessionId) !== undefined) {
				clearEarlyNudgeFired(sessionId)
				emitSteerOutcome(pi, "todo_early_nudge", "complied", { interactive: ctx.hasUI })
			}
			return
		}
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
				if (!isSteerDisabled("todo_early_nudge")) {
					markTodoNudgeFired(sessionId)
					pi.sendMessage(hiddenTodoMessage(TODO_EARLY_NUDGE_MESSAGE), { deliverAs: "steer" })
					emitSteerFired(pi, "todo_early_nudge", "early_nudge", { interactive: ctx.hasUI })
					markEarlyNudgeFired(sessionId, count)
				}
			}
		}

		// Nudge outcome tracking (plan E.3): after the early nudge, watch the
		// next N non-todo tool calls. A todo write within the window is
		// "complied"; the window expiring without a todo list is "repeated".
		const nudgeFiredAt = getEarlyNudgeFiredAt(sessionId)
		if (nudgeFiredAt !== undefined && !hasEverHadTodos(sessionId)) {
			if (getWorkToolCalls(sessionId) - nudgeFiredAt >= EARLY_NUDGE_OUTCOME_WINDOW) {
				clearEarlyNudgeFired(sessionId)
				emitSteerOutcome(pi, "todo_early_nudge", "repeated", { interactive: ctx.hasUI })
			}
		}

		// Only track staleness when there are existing todos to keep in sync.
		const scope = resolveTodoScope()
		if (!getTodosForScope(scope, sessionId).some((todo) => todo.status !== TODO_STATUS.COMPLETED)) return

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
				if (text)
					sendHiddenSteer(
						pi,
						TODO_STALENESS_CUSTOM_TYPE,
						text,
						{ reason: "staleness", threshold },
						{ steerKind: "todo_staleness", interactive: ctx.hasUI, sessionId },
					)
			},
		})
	})

	pi.on("turn_end", (event, ctx) => {
		const message = event.message
		if (!isRecord(message) || message.role !== "assistant") return
		if ((event.toolResults as readonly unknown[]).length > 0 || ctx.hasPendingMessages?.()) return
		if (message.stopReason === "aborted" || message.stopReason === "error") return
		syncTodoWidget(ctx)
		if (message.stopReason !== "stop" || isAwaitingUserAnswer(message)) return
		const scope = resolveTodoScope()
		if (scope.kind !== "global") return
		const todos = getTodosForScope(scope, ctx.sessionManager.getSessionId()).filter(
			(todo) => todo.status === TODO_STATUS.PENDING || todo.status === TODO_STATUS.IN_PROGRESS,
		)
		if (todos.length === 0 || !pi.getActiveTools().some(isTodoWriteToolName)) return
		const branch = ctx.sessionManager.getBranch()
		const request = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user")
		// Persisted history bounds cleanup per user request, even after todo writes or replay.
		if (
			request < 0 ||
			branch
				.slice(request + 1)
				.some((entry) => entry.type === "custom_message" && entry.customType === TODO_CLOSURE_CUSTOM_TYPE)
		)
			return
		if (
			!branch
				.slice(request + 1)
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						!isTodoWriteToolName(entry.message.toolName),
				)
		)
			return
		const ferment = restoreFermentV2(
			branch.flatMap((entry) =>
				entry.type === "custom" && entry.customType === FERMENT_V2_CUSTOM_ENTRY_TYPE ? [entry.data] : [],
			),
		)
		if (ferment && ferment.status !== FERMENT_V2_STATUS.COMPLETE) return
		sendHiddenSteer(
			pi,
			TODO_CLOSURE_CUSTOM_TYPE,
			`The turn ended with unfinished todos. Check bookkeeping against the work already done in this conversation. Use only todo tools if corrections are needed: mark fully finished work completed and remove obsolete items with update_todos. Preserve deferred, blocked, uncertain, and awaiting-approval work; do not claim an abandoned approach succeeded. Do not perform task work, request approval, or repeat the final answer. If nothing needs correcting, stop.\n\n${JSON.stringify(todos)}`,
			{ reason: "terminal-turn-closure" },
		)
	})

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTodoStore?.()
		unsubscribeTodoStore = undefined
		disposeTodoWidget(ctx)

		const sessionId = ctx.sessionManager.getSessionId()
		deleteSessionContext(sessionId)
	})
}
