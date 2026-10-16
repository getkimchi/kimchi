import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../../resources/store.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { FERMENT_V2_CUSTOM_ENTRY_TYPE } from "../ferment-v2/constants.js"
import { restoreFermentV2 } from "../ferment-v2/reducer.js"
import { FERMENT_V2_STATUS } from "../ferment-v2/types.js"
import { isAwaitingUserAnswer } from "../orchestration/continuation-nudge.js"
import { emitSteerFired, emitSteerOutcome, isSteerDisabled } from "../steer-events.js"
import { markHarnessSteer } from "../steer-marker.js"
import {
	addStalenessPending,
	CHECKIN_DELIVERED_BOUNDARY_REQUIRED,
	CHECKIN_HARD_THRESHOLD,
	type CheckinPending,
	canOpenStalenessGate,
	disposeCheckinGateSession,
	dropIrrelevantPending,
	getPendingCheckins,
	getRelevantCheckinScopes,
	handleCheckinReplay,
	hasStalenessGateOpened,
	isScopeCheckedIn,
	markStalenessGateOpened,
	markUserInputPending,
	reconcileCheckinScope,
	recordStalenessOpening,
	resetScopeEpoch,
	setCheckinEnforcementActive,
	subscribeCheckinGate,
} from "./checkin-gate.js"
import { registerTodosCommand } from "./command.js"
import { TODO_CLOSURE_CUSTOM_TYPE, TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { registerTodoStatePersistence } from "./context-state.js"
import { registerFermentTodoPromptBlock } from "./ferment-prompt-block.js"
import { registerTodoPromptBlock } from "./prompt-block.js"
import {
	advanceInputRevision,
	clearScopeReconciliations,
	disposeSessionReconciliation,
	getInputRevision,
	isScopeReconciledForLatestInput,
	recordAdmittedInputRevision,
	recordScopeReconciliation,
} from "./reconciliation.js"
import { getTodoScopeKey } from "./scope.js"
import { getWriteTodosDetails, isTodoWriteToolName } from "./session.js"
import {
	createIntervalSteerTracker,
	sendHiddenSteer,
	stalenessIndicator,
	stalenessScopeLabel,
	TODO_STALENESS_CUSTOM_TYPE,
	TODO_STALENESS_INTERVAL,
} from "./staleness-steers.js"
import {
	bumpToolCallsSinceTodoWrite,
	bumpWorkToolCalls,
	clearToolCallsSinceTodoWriteForSession,
	GLOBAL_TODO_SCOPE,
	getTodosForScope,
	getWorkToolCalls,
	hasEverHadTodos,
	hasTodoNudgeFired,
	markTodoNudgeFired,
	resetToolCallsSinceTodoWrite,
	resolveTodoScope,
	restoreTodoStoreFromDetails,
	subscribeTodoStore,
} from "./store.js"
import { CONFIRM_TODOS_TOOL_NAME, registerTodosTool } from "./tool.js"
import { TODO_STATUS, type TodoScope } from "./types.js"
import {
	disposeTodoWidget,
	ensureTodoWidget,
	registerTodoShortcut,
	resetTodoWidgetState,
	syncTodoWidget,
} from "./widget.js"

export * from "./checkin-gate.js"
export * from "./command.js"
export * from "./constants.js"
export * from "./ferment-prompt-block.js"
export * from "./prompt-block.js"
export * from "./reconciliation.js"
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
 *  during which adoption is measured. A todo write within the
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

const TODOS_RESOURCE_ID = "extensions.todos"

export const TODO_CHECKIN_CUSTOM_TYPE = "todo-checkin"

/** Prerequisites for check-in enforcement, rechecked at every enforcement
 *  point: the resource enabled, the kill switch off, and an active
 *  reconciliation tool for the pending scope. When these are unavailable
 *  the gate releases (work is not blocked). */
function isCheckinEnforcementAvailable(pi: ExtensionAPI): boolean {
	if (!isResourceEnabled(TODOS_RESOURCE_ID)) return false
	if (isSteerDisabled("todo_checkin")) return false
	const tools = pi.getActiveTools()
	return tools.some(isTodoWriteToolName) || tools.includes(CONFIRM_TODOS_TOOL_NAME)
}

function renderCheckinList(scope: TodoScope, sessionId: string): string {
	const todos = getTodosForScope(scope, sessionId)
	if (todos.length === 0) return "(empty)"
	return todos.map((todo) => `- [${todo.status}] #${todo.id} ${todo.content}`).join("\n")
}

/** Hidden-steer instruction sent once per accepted input revision when
 *  checks are pending — before the model's first work tool of the new
 *  request, so reconciliation can share the next turn. */
function checkinInstructionText(pending: readonly CheckinPending[], sessionId: string, revision: number): string {
	const lines = [
		`Todo check-in (input revision ${revision}): the user's latest input may change the plan. Before starting further work tools, reconcile each list below — add newly requested work, remove obsolete items, revise statuses — or, when a list is still accurate, confirm it with confirm_todos, passing its complete current id+status set and inputRevision ${revision}. A text-only reply needs no tool call; the check stays pending until work resumes.`,
	]
	for (const check of pending) {
		lines.push(
			"",
			`${stalenessScopeLabel(check.scope)} list (input revision ${revision}):`,
			renderCheckinList(check.scope, sessionId),
		)
	}
	return lines.join("\n")
}

/** Block reason for work tools admitted while a check is pending. Carries
 *  the current instructions on every blocked call — without queuing
 *  repeated steer messages. */
function checkinBlockReason(pending: readonly CheckinPending[], sessionId: string, revision: number): string {
	const lines = [
		`⏸ Todo check-in pending (input revision ${revision}). Reconcile the todo list with the user's latest direction and the work already done before starting further work tools: add newly requested work, remove obsolete items, revise statuses — or, if a list is still accurate, confirm it with confirm_todos, passing its complete current id+status set and inputRevision ${revision}. Finish the reconciliation tool round first; do not batch reconciliation in parallel with work tools.`,
	]
	for (const check of pending) {
		lines.push(
			"",
			`${stalenessScopeLabel(check.scope)} list (input revision ${revision}):`,
			renderCheckinList(check.scope, sessionId),
		)
	}
	return lines.join("\n")
}

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
	let unsubscribeCheckinGate: (() => void) | undefined

	// Recurring staleness reminders: fire every TODO_STALENESS_INTERVAL
	// successful work calls per scope, with no final ceiling. The tracker
	// resets (via the subscribeTodoStore listener below) only on a write to
	// the same scope — writes to one list never silence pressure on another.
	const stalenessTracker = createIntervalSteerTracker()

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
		// Replay / branch changes clear every scope's counters and fired bands
		// for this session and invalidate unproven acknowledgments.
		clearToolCallsSinceTodoWriteForSession(sessionId)
		stalenessTracker.clearSession(sessionId)
		clearScopeReconciliations(sessionId)
		// Replay rebuilds gate state from the restored lists: relevant
		// unfinished lists require reconciliation before resumed work.
		// Historical messages are not fresh input (the input revision is
		// not advanced).
		handleCheckinReplay(sessionId)
		syncTodoWidget(ctx)
	}

	// Genuine user input (interactive or rpc — never extension injections or
	// replayed history) advances the session's input revision. A newer input
	// invalidates earlier reconciliation: what must be reconciled changed.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return
		const sessionId = ctx.sessionManager.getSessionId()
		const revision = advanceInputRevision(sessionId)
		// Publish the effective enforcement state first: a release while
		// checks are pending must stop surfaces from showing a pause, while
		// preserving the unreconciled revisions for re-enablement.
		setCheckinEnforcementActive(sessionId, isCheckinEnforcementAvailable(pi))
		// Routine request-boundary check: new input may change the course of
		// action, so relevant unfinished lists require reconciliation before
		// further work. Existing checks and staleness are preserved — a new
		// message never counts as reconciliation by itself.
		if (!isCheckinEnforcementAvailable(pi)) return
		markUserInputPending(sessionId, getRelevantCheckinScopes(sessionId), revision)
		// One reconciliation instruction per accepted input revision.
		const pending = getPendingCheckins(sessionId)
		if (pending.length > 0) {
			sendHiddenSteer(
				pi,
				TODO_CHECKIN_CUSTOM_TYPE,
				checkinInstructionText(pending, sessionId, revision),
				{ reason: "user_input", inputRevision: revision },
				{ steerKind: "todo_checkin", steerReason: "checkin", interactive: ctx.hasUI, sessionId },
			)
		}
		syncTodoWidget(ctx)
	})

	// Work-tool admission gate. Todo reconciliation tools pass through;
	// work tools are blocked while any relevant check is pending. The block
	// reason carries current instructions on every call.
	pi.on("tool_call", (event, ctx) => {
		const toolName = event.toolName
		if (!toolName) return { block: false }
		const sessionId = ctx.sessionManager.getSessionId()

		// Capture the admitted input revision for todo write tools: a write
		// can only acknowledge the input accepted when its call was admitted,
		// never newer input that arrived while the call was executing.
		if (isTodoWriteToolName(toolName)) {
			recordAdmittedInputRevision(sessionId, event.toolCallId, getInputRevision(sessionId))
			return { block: false }
		}
		// confirm_todos carries its own revision validation and is never a
		// blocked "work tool" while the gate is open.
		if (toolName === CONFIRM_TODOS_TOOL_NAME) return { block: false }

		// Prerequisites are rechecked on enforcement: resource disablement,
		// the kill switch, or missing reconciliation tools release the gate.
		// The release is published so surfaces stop showing a pause, while the
		// unreconciled revisions are preserved for re-enablement.
		if (!isCheckinEnforcementAvailable(pi)) {
			setCheckinEnforcementActive(sessionId, false)
			return { block: false }
		}
		setCheckinEnforcementActive(sessionId, true)
		const revision = getInputRevision(sessionId)
		// Fresh evaluation: a list that became relevant since the last check
		// (a step activating mid-request, a background seed write, replay, or
		// re-enablement) is checked against the current input revision before
		// its first work tool. Stale entries for emptied lists are dropped.
		const relevant = getRelevantCheckinScopes(sessionId)
		markUserInputPending(
			sessionId,
			relevant.filter((scope) => !isScopeCheckedIn(scope, sessionId)),
			revision,
		)
		dropIrrelevantPending(sessionId, relevant)

		const pending = getPendingCheckins(sessionId)
		if (pending.length === 0) return { block: false }
		return { block: true, reason: checkinBlockReason(pending, sessionId, revision) }
	})

	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId()
		setSessionContext(sessionId, ctx)

		resetTodoWidgetState(ctx)
		ensureTodoWidget(ctx)

		// Publish the effective enforcement state for this session before the
		// first repaint (replaying restored lists may leave pending checks).
		setCheckinEnforcementActive(sessionId, isCheckinEnforcementAvailable(pi))

		unsubscribeTodoStore?.()
		unsubscribeTodoStore = subscribeTodoStore((details, emitterSessionId, context) => {
			// A real assistant or command write reconciles its scope against the
			// input revision captured when the write was admitted. Background
			// (bridge/unattributed) writes do not reconcile — they only
			// invalidate prior reconciliation by bumping the list version.
			if (
				context &&
				(context.origin === "tool" || context.origin === "command") &&
				context.inputRevision !== undefined
			) {
				recordScopeReconciliation(details.scope, emitterSessionId, context.inputRevision)
				if (reconcileCheckinScope(emitterSessionId, details.scope, context.inputRevision)) {
					emitSteerOutcome(pi, "todo_checkin", "complied", { method: "write", interactive: ctx.hasUI })
				}
			}
			// Any write to a scope starts a new staleness epoch (re-arming
			// escalation for that scope) and resets only that list's counters —
			// pressure on other lists keeps accumulating (a step update must not
			// silence the neglected global list, and vice versa).
			resetScopeEpoch(emitterSessionId, details.scope)
			resetToolCallsSinceTodoWrite(details.scope, emitterSessionId)
			stalenessTracker.reset(emitterSessionId, getTodoScopeKey(details.scope))
			// A write that empties or fully completes a pending list clears its
			// check immediately — including background (bridge) writes, which do
			// not reconcile — so neither surface keeps reporting an obsolete
			// pause until the next work call re-evaluates relevance.
			dropIrrelevantPending(emitterSessionId, getRelevantCheckinScopes(emitterSessionId))
			const sessionCtx = getSessionContext(emitterSessionId)
			if (sessionCtx) syncTodoWidget(sessionCtx)
		})

		unsubscribeCheckinGate?.()
		unsubscribeCheckinGate = subscribeCheckinGate((sessionId, change) => {
			if (change.kind === "reconciled" && change.method === "confirm") {
				// A successful confirmation resets only that scope's staleness
				// epoch and schedule — like a write, but without a synthetic store
				// write.
				resetScopeEpoch(sessionId, change.scope)
				resetToolCallsSinceTodoWrite(change.scope, sessionId)
				stalenessTracker.reset(sessionId, getTodoScopeKey(change.scope))
				emitSteerOutcome(pi, "todo_checkin", "complied", { method: "confirm", interactive: ctx.hasUI })
			}
			if (change.kind === "confirm_mismatch") {
				emitSteerOutcome(pi, "todo_checkin", "repeated", { method: change.method, interactive: ctx.hasUI })
			}
			const sessionCtx = getSessionContext(sessionId)
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
		// confirm_todos is neither a write nor work: it does not satisfy
		// early-nudge adoption and never increments work or staleness
		// counters.
		if (event.toolName === CONFIRM_TODOS_TOOL_NAME) return
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
					emitSteerFired(pi, "todo_early_nudge", "early_nudge", {
						interactive: ctx.hasUI,
						sessionId: ctx.sessionManager.getSessionId(),
					})
					markEarlyNudgeFired(sessionId, count)
				}
			}
		}

		// Nudge outcome tracking: after the early nudge, watch the
		// next N non-todo tool calls. A todo write within the window is
		// "complied"; the window expiring without a todo list is "repeated".
		const nudgeFiredAt = getEarlyNudgeFiredAt(sessionId)
		if (nudgeFiredAt !== undefined && !hasEverHadTodos(sessionId)) {
			if (getWorkToolCalls(sessionId) - nudgeFiredAt >= EARLY_NUDGE_OUTCOME_WINDOW) {
				clearEarlyNudgeFired(sessionId)
				emitSteerOutcome(pi, "todo_early_nudge", "repeated", { interactive: ctx.hasUI })
			}
		}

		// Per-scope staleness pressure, computed from the same relevance set as
		// the check-in gate (global + active step, unfinished items only) so
		// the two policies cannot drift: updating one list must not silence
		// pressure on another, inactive historical step lists and
		// lifecycle-managed phase lists do not age, and a step resumes its
		// counter when active.
		for (const scope of getRelevantCheckinScopes(sessionId)) {
			const count = bumpToolCallsSinceTodoWrite(scope, sessionId)
			const scopeKey = getTodoScopeKey(scope)

			// Staleness pressure as bounded recurring steers, not as volatile text
			// inside the persisted state block (which must stay byte-identical
			// between real writes for prefix-cache stability).
			stalenessTracker.fireInterval({
				sessionId,
				scopeKey,
				count,
				interval: TODO_STALENESS_INTERVAL,
				send: (boundary) => {
					const text = stalenessIndicator(count, scope)
					if (!text) return false
					// Delivery, not intent: a kill-switch-suppressed reminder must
					// not count as delivered — otherwise escalation could open with
					// no warning ever reaching the model.
					return sendHiddenSteer(
						pi,
						TODO_STALENESS_CUSTOM_TYPE,
						text,
						{ reason: "staleness", threshold: boundary, scope },
						{ steerKind: "todo_staleness", interactive: ctx.hasUI, sessionId },
					)
				},
			})

			// Staleness escalation: a list that aged past CHECKIN_HARD_THRESHOLD
			// while ignoring a delivered boundary-30+ reminder opens the
			// check-in gate — bounded to one opening per scope write-epoch and
			// two per user request. The routine user-input check is never
			// budget-limited.
			if (count >= CHECKIN_HARD_THRESHOLD && isCheckinEnforcementAvailable(pi)) {
				const deliveredBoundary = stalenessTracker.highestDelivered(sessionId, scopeKey)
				if (
					deliveredBoundary !== undefined &&
					deliveredBoundary >= CHECKIN_DELIVERED_BOUNDARY_REQUIRED &&
					!hasStalenessGateOpened(sessionId, scope) &&
					canOpenStalenessGate(sessionId, getInputRevision(sessionId))
				) {
					const revision = getInputRevision(sessionId)
					markStalenessGateOpened(sessionId, scope)
					recordStalenessOpening(sessionId, revision)
					// A scope already pending for user input gets the additional
					// reason without a duplicate message; the next blocked work tool
					// carries the instructions.
					addStalenessPending(sessionId, scope, revision)
					emitSteerFired(pi, "todo_checkin", "staleness", { interactive: ctx.hasUI, sessionId })
				}
			}
		}
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
		// Suppression: the global list was already reconciled against the
		// latest accepted user input (real write or confirmation), and nothing
		// has invalidated that since — a duplicate cleanup turn would only
		// repeat that check. Requests without prior work tools already
		// qualified before; removing the work-tool guard extends the same
		// bounded check to conversational requests with old unfinished todos.
		if (isScopeReconciledForLatestInput(GLOBAL_TODO_SCOPE, ctx.sessionManager.getSessionId())) return
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
		unsubscribeCheckinGate?.()
		unsubscribeCheckinGate = undefined
		disposeTodoWidget(ctx)

		const sessionId = ctx.sessionManager.getSessionId()
		deleteSessionContext(sessionId)
		// Remove this session's staleness bookkeeping; other sessions on the
		// same host are unaffected.
		clearToolCallsSinceTodoWriteForSession(sessionId)
		stalenessTracker.clearSession(sessionId)
		disposeCheckinGateSession(sessionId)
		disposeSessionReconciliation(sessionId)
	})
}
