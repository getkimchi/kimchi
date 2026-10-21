import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { isResourceEnabled } from "../../resources/store.js"
import { REVIEW_HANDOFF_TOOL_NAMES, SUBMIT_PLAN_TOOL_NAME } from "../../shared/planning/tool-catalog.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { FERMENT_V2_CUSTOM_ENTRY_TYPE } from "../ferment-v2/constants.js"
import { restoreFermentV2 } from "../ferment-v2/reducer.js"
import { FERMENT_V2_STATUS } from "../ferment-v2/types.js"
import { isAwaitingUserAnswer } from "../orchestration/continuation-nudge.js"
import { isReadOnlyTool } from "../permissions/taxonomy.js"
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
	isCheckinPending,
	isScopeCheckedIn,
	markCheckinPending,
	markStalenessGateOpened,
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
import { renderTodoEntries } from "./state-markdown.js"
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

/** Latest check-in instruction fire per session, so outcome events can be
 *  attributed back to the opening that caused them (the instruction fires
 *  carry no outcome watcher of their own — the outcome is emitted when the
 *  check actually closes). */
const checkinSteerIds = new Map<string, string>()

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
 *  reconciliation tool. The todo tools are scope-agnostic (every write
 *  tool and confirm_todos accepts a scope argument), so registration is
 *  checked globally rather than per pending scope. When these are
 *  unavailable the gate releases (work is not blocked). */
function isCheckinEnforcementAvailable(pi: ExtensionAPI): boolean {
	if (!isResourceEnabled(TODOS_RESOURCE_ID)) return false
	if (isSteerDisabled("todo_checkin")) return false
	const tools = pi.getActiveTools()
	return tools.some(isTodoWriteToolName) || tools.includes(CONFIRM_TODOS_TOOL_NAME)
}

function renderCheckinList(scope: TodoScope, sessionId: string): string {
	return renderTodoEntries(getTodosForScope(scope, sessionId), { empty: "(empty)", separator: "\n", prefix: "- " })
}

/** Per-scope list blocks shared by every check-in surface text: a blank
 *  line, the scope-labelled header, and the rendered list. */
function checkinListBlocks(scopes: readonly TodoScope[], sessionId: string, revision: number): string[] {
	const lines: string[] = []
	for (const scope of scopes) {
		lines.push(
			"",
			`${stalenessScopeLabel(scope)} list (input revision ${revision}):`,
			renderCheckinList(scope, sessionId),
		)
	}
	return lines
}

/** Hidden-steer instruction sent once per accepted input revision when
 *  checks are pending — before the model's first work tool of the new
 *  request, so reconciliation can share the next turn. */
function checkinInstructionText(pending: readonly CheckinPending[], sessionId: string, revision: number): string {
	return [
		`Todo check-in (input revision ${revision}): the user's latest input may change the plan. Before starting further work tools, reconcile each list below — add newly requested work, remove obsolete items, revise statuses — or, when a list is still accurate, confirm it with confirm_todos, passing its complete current id+status set and inputRevision ${revision}. A text-only reply needs no tool call; the check stays pending until work resumes.`,
		...checkinListBlocks(
			pending.map((check) => check.scope),
			sessionId,
			revision,
		),
	].join("\n")
}

/** Block reason for work tools admitted while a check is pending. Carries
 *  the current instructions on every blocked call — without queuing
 *  repeated steer messages. */
function checkinBlockReason(pending: readonly CheckinPending[], sessionId: string, revision: number): string {
	return [
		`⏸ Todo check-in pending (input revision ${revision}). Reconcile the todo list with the user's latest direction and the work already done before starting further work tools: add newly requested work, remove obsolete items, revise statuses — or, if a list is still accurate, confirm it with confirm_todos, passing its complete current id+status set and inputRevision ${revision}. Finish the reconciliation tool round first; do not batch reconciliation in parallel with work tools. Every non-todo tool is gated — submitting a plan included: reconcile or confirm the list first, then proceed.`,
		...checkinListBlocks(
			pending.map((check) => check.scope),
			sessionId,
			revision,
		),
	].join("\n")
}

/** Hidden-steer instruction sent when a plan submission leaves the global
 *  list structurally stale — work completed while finalizing the plan that
 *  the list does not reflect. Delivered with the review-outcome turn
 *  (approval, denial feedback, or any user message), so reconciliation
 *  shares that turn before further work tools. */
function planSubmissionCheckinText(sessionId: string, revision: number): string {
	return [
		`Todo check-in (input revision ${revision}): the plan was submitted for review, and work completed while finalizing it may not be reflected in the list below. Before starting further work tools, reconcile the list — mark finished work completed, remove items the submitted plan supersedes — or, when the list is still accurate, confirm it with confirm_todos, passing its complete current id+status set and inputRevision ${revision}. A text-only reply needs no tool call; the check stays pending until work resumes.`,
		...checkinListBlocks([GLOBAL_TODO_SCOPE], sessionId, revision),
	].join("\n")
}

/** Plan-submission boundary: submit_plan ends the turn for user review, and
 *  no further mechanism runs before the review outcome — the closure steer
 *  needs a final-answer turn, staleness reminders are advisory, and the
 *  check-in gate fires on genuine user input only. An unfinished global
 *  list that was not reconciled after the work done while finalizing the
 *  plan (work tools completed since the last reconciliation) therefore
 *  arms the gate here, so the review-outcome turn starts with reconciliation
 *  before further work. Suppressed when the model already did its
 *  bookkeeping: a list reconciled after its last completed work (e.g. the
 *  final todo write paired with submit_plan) and fully completed lists are
 *  left alone. */
function armPlanSubmissionCheckin(pi: ExtensionAPI, sessionId: string, interactive: boolean): void {
	if (!isCheckinEnforcementAvailable(pi)) return
	// The gate targets the global list of THIS session: the active-scope
	// lookup is session-aware, so a ferment step running in another session
	// of the same process cannot suppress it.
	if (resolveTodoScope(sessionId).kind !== "global") return
	const todos = getTodosForScope(GLOBAL_TODO_SCOPE, sessionId).filter(
		(todo) => todo.status === TODO_STATUS.PENDING || todo.status === TODO_STATUS.IN_PROGRESS,
	)
	if (todos.length === 0) return
	if (isScopeReconciledForLatestInput(GLOBAL_TODO_SCOPE, sessionId)) return
	// Already pending (e.g. user input arrived during the review, or the
	// staleness escalation opened earlier) — its own steer/block reason
	// carries the instructions; don't queue a duplicate message.
	if (isCheckinPending(GLOBAL_TODO_SCOPE, sessionId)) return
	const revision = getInputRevision(sessionId)
	markCheckinPending([GLOBAL_TODO_SCOPE], sessionId, revision, "plan_submission")
	sendHiddenSteer(pi, TODO_CHECKIN_CUSTOM_TYPE, planSubmissionCheckinText(sessionId, revision), {
		reason: "plan_submission",
		inputRevision: revision,
	})
	const steerId = emitSteerFired(pi, "todo_checkin", "plan_submission", { interactive, sessionId })
	if (steerId) checkinSteerIds.set(sessionId, steerId)
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

	// A queued follow-up (streamingBehavior "followUp") is delivered only
	// after the current run ends. Arming the check at receipt would block
	// work against a direction the model cannot see yet — and a blind
	// confirmation would consume the revision before the message lands. The
	// texts below are delivered (message_start) in queue order.
	const deferredCheckinInputs = new Map<string, string[]>()

	// Recent steered/idle input texts, consumed by the user message they
	// produce: lets the message_start consumer attribute a user message to
	// the immediate input that caused it, instead of to a queued follow-up.
	const recentImmediateInputs = new Map<string, string[]>()

	/** Reset one list's staleness bookkeeping — epoch, counter, and reminder
	 *  schedule. A write or successful confirmation to a list re-arms its
	 *  pressure; other lists keep accumulating. */
	const resetScopeStaleness = (scope: TodoScope, sessionId: string): void => {
		resetScopeEpoch(scope, sessionId)
		resetToolCallsSinceTodoWrite(scope, sessionId)
		stalenessTracker.reset(sessionId, getTodoScopeKey(scope))
	}

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
		deferredCheckinInputs.delete(sessionId)
		recentImmediateInputs.delete(sessionId)
		checkinSteerIds.delete(sessionId)
		// Replay rebuilds gate state from the restored lists: relevant
		// unfinished lists require reconciliation before resumed work.
		// Historical messages are not fresh input (the input revision is
		// not advanced).
		handleCheckinReplay(sessionId)
		syncTodoWidget(ctx)
	}

	const deliverGenuineInput = (ctx: ExtensionContext, opts: { deferred: boolean }) => {
		const sessionId = ctx.sessionManager.getSessionId()
		const revision = advanceInputRevision(sessionId)
		// Publish the effective enforcement state first: a release while
		// checks are pending must stop surfaces from showing a pause, while
		// preserving the unreconciled revisions for re-enablement.
		const available = isCheckinEnforcementAvailable(pi)
		setCheckinEnforcementActive(sessionId, available)
		// Routine request-boundary check: new input may change the course of
		// action, so relevant unfinished lists require reconciliation before
		// further work. Existing checks and staleness are preserved — a new
		// message never counts as reconciliation by itself.
		if (!available) return
		markCheckinPending(getRelevantCheckinScopes(sessionId), sessionId, revision)
		const pending = getPendingCheckins(sessionId)
		if (pending.length > 0) {
			// Immediate inputs queue one instruction per received input revision.
			// Deferred follow-up deliveries skip the separate instruction: their
			// message_start fires inside the agent loop right before the response
			// streams, so a steer sent now is only read after the first tool
			// batch — the block reason carries the instructions instead, with
			// the model already looking at the new direction.
			if (!opts.deferred) {
				sendHiddenSteer(pi, TODO_CHECKIN_CUSTOM_TYPE, checkinInstructionText(pending, sessionId, revision), {
					reason: "user_input",
					inputRevision: revision,
				})
			}
			// The fire is emitted directly with no outcome watcher: the outcome
			// is attributed when the check actually closes, carrying this
			// steer_id.
			const steerId = emitSteerFired(pi, "todo_checkin", "checkin", { interactive: ctx.hasUI, sessionId })
			if (steerId) checkinSteerIds.set(sessionId, steerId)
		}
		syncTodoWidget(ctx)
	}

	// Genuine user input (interactive or rpc — never extension injections or
	// replayed history) advances the session's input revision. A newer input
	// invalidates earlier reconciliation: what must be reconciled changed.
	// The input event has receive semantics, not acceptance semantics: another
	// handler may still consume the submission afterwards ({ action: "handled" }
	// — e.g. a cancelled vision gate), leaving a pending check against a
	// revision the model never saw. Bounded and self-correcting — the next
	// real input re-arms the check legitimately.
	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return
		// Follow-ups are queued until the current run ends: defer the revision
		// advance and check until the message is actually delivered.
		if (event.streamingBehavior === "followUp") {
			const sessionId = ctx.sessionManager.getSessionId()
			deferredCheckinInputs.set(sessionId, [...(deferredCheckinInputs.get(sessionId) ?? []), event.text])
			return
		}
		// Steered and idle inputs advance at receipt; remember the text so the
		// user message it produces is attributed to this input (not to a queued
		// follow-up) at message_start.
		const sessionId = ctx.sessionManager.getSessionId()
		recentImmediateInputs.set(sessionId, [...(recentImmediateInputs.get(sessionId) ?? []), event.text].slice(-4))
		deliverGenuineInput(ctx, { deferred: false })
	})

	// Delivery point for queued follow-ups: the user message entering
	// history. A user message has one of three causes, resolved in order:
	// 1. a steered/idle input that already advanced at receipt — matched
	//    against the recent input texts;
	// 2. a delivered follow-up whose queued text survived upstream's queueing
	//    untouched — exact match;
	// 3. a delivered follow-up whose text was rewritten after the input event
	//    (skill/template expansion, a later input handler's transform) —
	//    consumed positionally, but only when no unconsumed immediate input
	//    could have produced this message, so a stale queue entry (dropped by
	//    upstream's clearQueue, e.g. an Esc pull-back) can never
	//    double-advance a later resubmission of the same text.
	// NOTE: extension-sourced follow-ups (e.g. the ferment plan-confirmation
	// reply, ferment/events.ts) are filtered at the input event, so they are
	// neither queued here nor recorded in recent — but their delivery still
	// produces a user message_start. They are sent at turn_end, after any
	// user follow-up queued during the run, so they cannot overtake one today;
	// if that ordering ever changes, the delivery attribution must key on the
	// message's source rather than position.
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "user") return
		const sessionId = ctx.sessionManager.getSessionId()
		const content = event.message.content
		const text =
			typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("")
		// Consume the immediate input this message was produced by — on every
		// user message, not only when a follow-up is pending. A session's own
		// prompt is delivered while the queue is still empty, and a leftover
		// recent entry would both swallow a repeated follow-up text and block
		// the positional fallback below. Rewritten prompts (whose delivered
		// text no longer matches the input event's) never text-match and are
		// cleared by the agent_end reset below.
		const recent = recentImmediateInputs.get(sessionId) ?? []
		// First match, not last: idle and steered prompts are delivered in
		// arrival order, so with repeated texts the delivered message is the
		// oldest matching entry.
		const recentIndex = recent.indexOf(text)
		const fromImmediateInput = recentIndex !== -1
		if (fromImmediateInput) {
			// Drop the match and every older entry: an entry older than the one
			// just delivered belongs to an input that will never be delivered
			// (swallowed by a later input handler, e.g. a cancelled vision gate)
			// and would otherwise block the positional fallback below.
			recent.splice(0, recentIndex + 1)
			recentImmediateInputs.set(sessionId, recent)
		}
		const queue = deferredCheckinInputs.get(sessionId)
		if (!queue || queue.length === 0) {
			// No follow-up is pending, so this message can only be an idle or
			// steered prompt's delivery. A rewritten prompt's entry never
			// text-matches — drop the oldest unconsumed recent entry anyway,
			// mirroring the follow-up fallback below: every user message
			// corresponds to exactly one input, so unconsumed entries cannot
			// linger past this message and block a follow-up delivery that
			// arrives before the agent_end reset.
			if (!fromImmediateInput && recent.length > 0) {
				recent.shift()
				recentImmediateInputs.set(sessionId, recent)
			}
			return
		}
		if (fromImmediateInput) {
			// Produced by an input that already advanced at receipt.
			return
		}
		const index = queue.indexOf(text)
		if (index !== -1) {
			queue.splice(index, 1)
		} else if (recent.length === 0) {
			// No unconsumed immediate input can have produced this message —
			// it is a delivered follow-up whose queued text was rewritten.
			queue.shift()
		} else {
			return
		}
		if (queue.length === 0) deferredCheckinInputs.delete(sessionId)
		deliverGenuineInput(ctx, { deferred: true })
	})

	// Run boundary: idle and steered prompts are delivered within the run
	// that received them, and a rewritten one never text-matches — so any
	// recent entry still held here can no longer produce a message. Reset
	// the attribution list so leftovers cannot block the next follow-up
	// delivery's positional fallback.
	pi.on("agent_end", (_event, ctx) => {
		recentImmediateInputs.delete(ctx.sessionManager.getSessionId())
	})

	// Work-tool admission gate. Only reconciliation tools (todo writes,
	// confirm_todos) pass through; every other tool is blocked while any
	// relevant check is pending — including submit_plan, deliberately: the
	// plan handoff must carry reconciled todos, so a stale list cannot be
	// frozen into the user-review boundary. The block reason carries
	// current instructions on every call.
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

		// Read-only tools (including questionnaire) pass while gated: they
		// cannot make the list staler, and the model may need to inspect state
		// or ask the user a clarifying question in order to reconcile against
		// the latest direction. The taxonomy is the same one permission modes
		// use — one source of truth for "read-only". Review handoffs
		// (submit_plan, workflow submissions) are excepted: they end the turn
		// for user/orchestrator review and must carry reconciled todos like
		// any work tool.
		if (isReadOnlyTool(toolName) && !REVIEW_HANDOFF_TOOL_NAMES.has(toolName)) return { block: false }

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
		markCheckinPending(
			relevant.filter((scope) => !isScopeCheckedIn(scope, sessionId)),
			sessionId,
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
			// Telemetry and widget updates follow the *emitting* session: on
			// multi-session hosts the registering session's flags would
			// mislabel them.
			const sessionCtx = getSessionContext(emitterSessionId)
			// A real assistant or command write reconciles its scope against the
			// input revision captured when the write was admitted. Unattributed
			// writes (no context, e.g. the ferment bridge) do not reconcile —
			// they only invalidate prior reconciliation by bumping the list
			// version.
			let closedByWrite = false
			if (
				context &&
				(context.origin === "tool" || context.origin === "command") &&
				context.inputRevision !== undefined
			) {
				recordScopeReconciliation(details.scope, emitterSessionId, context.inputRevision)
				closedByWrite = reconcileCheckinScope(details.scope, emitterSessionId, context.inputRevision)
			}
			// Any write to a scope starts a new staleness epoch (re-arming
			// escalation for that scope) and resets only that list's counters —
			// pressure on other lists keeps accumulating (a step update must not
			// silence the neglected global list, and vice versa).
			resetScopeStaleness(details.scope, emitterSessionId)
			// A write that empties or fully completes a pending list clears its
			// check immediately — including unattributed background writes,
			// which do not reconcile — so neither surface keeps reporting an
			// obsolete pause until the next work call re-evaluates relevance.
			dropIrrelevantPending(emitterSessionId, getRelevantCheckinScopes(emitterSessionId))
			// One outcome per opening: emitted when the LAST pending list closes,
			// not once per list. A list emptied by the write closes silently —
			// the opening's steer_id is not left behind for a later opening to
			// inherit.
			if (closedByWrite && getPendingCheckins(emitterSessionId).length === 0) {
				const steerId = checkinSteerIds.get(emitterSessionId)
				emitSteerOutcome(pi, "todo_checkin", "complied", {
					method: "write",
					steerId,
					interactive: sessionCtx?.hasUI ?? false,
				})
			}
			if (getPendingCheckins(emitterSessionId).length === 0) checkinSteerIds.delete(emitterSessionId)
			if (sessionCtx) syncTodoWidget(sessionCtx)
		})

		unsubscribeCheckinGate?.()
		unsubscribeCheckinGate = subscribeCheckinGate((sessionId, change) => {
			// Telemetry and widget updates follow the emitting session, not
			// the session whose session_start registered this listener.
			const sessionCtx = getSessionContext(sessionId)
			if (change.kind === "reconciled" && change.method === "confirm") {
				// A successful confirmation resets only that scope's staleness
				// epoch and schedule — like a write, but without a synthetic store
				// write.
				resetScopeStaleness(change.scope, sessionId)
				// One outcome per opening: the complied is emitted when the LAST
				// pending list closes, not once per list — and only when a check
				// actually closed (a confirmation with nothing pending just resets
				// the schedule).
				if (change.closed && getPendingCheckins(sessionId).length === 0) {
					const steerId = checkinSteerIds.get(sessionId)
					emitSteerOutcome(pi, "todo_checkin", "complied", {
						method: "confirm",
						steerId,
						interactive: sessionCtx?.hasUI ?? false,
					})
					checkinSteerIds.delete(sessionId)
				}
			}
			if (change.kind === "confirm_mismatch") {
				emitSteerOutcome(pi, "todo_checkin", "repeated", {
					method: change.method,
					steerId: checkinSteerIds.get(sessionId),
					interactive: sessionCtx?.hasUI ?? false,
				})
			}
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

		// submit_plan ends the turn for user review — the plan handoff is a
		// request boundary for todo hygiene (see armPlanSubmissionCheckin).
		// Like confirm_todos, the submission is neither write nor work: it
		// never increments the counters, so a model that pairs its final todo
		// write with submit_plan stays suppressed.
		if (event.toolName === SUBMIT_PLAN_TOOL_NAME) {
			armPlanSubmissionCheckin(pi, sessionId, ctx.hasUI)
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
					!hasStalenessGateOpened(scope, sessionId) &&
					canOpenStalenessGate(sessionId, getInputRevision(sessionId))
				) {
					const revision = getInputRevision(sessionId)
					markStalenessGateOpened(scope, sessionId)
					recordStalenessOpening(sessionId, revision)
					// A scope already pending for user input gets the additional
					// reason without a duplicate message; the next blocked work tool
					// carries the instructions.
					addStalenessPending(scope, sessionId, revision)
					const steerId = emitSteerFired(pi, "todo_checkin", "staleness", { interactive: ctx.hasUI, sessionId })
					if (steerId) checkinSteerIds.set(sessionId, steerId)
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
		const scope = resolveTodoScope(ctx.sessionManager.getSessionId())
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
		deferredCheckinInputs.delete(sessionId)
		recentImmediateInputs.delete(sessionId)
		checkinSteerIds.delete(sessionId)
		disposeCheckinGateSession(sessionId)
		disposeSessionReconciliation(sessionId)
	})
}
