import { randomUUID } from "node:crypto"
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import { isAgentWorker } from "../agent-worker-context.js"
import { formatCount } from "../format.js"
import { addPromptSummaryMetric } from "../prompt-summary.js"
import { isStaleCtxError } from "../stale-ctx.js"
import { getTodoScopeKey, normalizeTodoScope } from "../todos/scope.js"
import { getWriteTodosDetails, isWriteTodosDetails } from "../todos/session.js"
import { resolveTodoScope } from "../todos/store.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import type { TodoItem } from "../todos/types.js"
import { formatGoalStatusAccounting, formatGoalSummary, GOAL_COMMAND_COMPLETIONS, parseGoalCommand } from "./command.js"
import {
	GET_GOAL_TOOL_NAME,
	GOAL_CONTROL_MESSAGE_TYPE,
	GOAL_CUSTOM_ENTRY_TYPE,
	GOAL_STATUS_KEY,
	GOAL_TOOL_NAMES,
	UPDATE_GOAL_TOOL_NAME,
} from "./constants.js"
import { GOAL_EVENTS, type GoalEventName, type GoalLifecyclePayload } from "./domain-events.js"
import { evaluateGoal, type GoalEvaluationResult } from "./evaluator.js"
import { type GoalLesson, updateGoalLessons } from "./lessons.js"
import {
	buildGoalContinuation,
	buildGoalEditSteer,
	buildGoalErrorContinuation,
	buildGoalStartSteer,
	buildGoalStopSteer,
	replaceGoalContextMessages,
} from "./prompt.js"
import {
	addGoalAccounting,
	clearGoal,
	clearGoalEntry,
	createGoal,
	editGoal,
	type GoalState,
	isRecord,
	putGoalEntry,
	recordGoalEvaluation,
	replaceGoal,
	restoreGoal,
	setGoalConsecutiveErrorTurns,
	setGoalStatus,
	setGoalUnchangedContinuationTurns,
} from "./reducer.js"
import { getGoalSettings } from "./settings.js"
import {
	GOAL_COMPLETION_CONFIDENCES,
	type GoalEvaluation,
	type PendingGoalContinuation,
	type SessionGoal,
} from "./types.js"

const UPDATE_GOAL_PARAMETERS = Type.Object({
	status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
	completion_confidence: Type.Optional(
		Type.Union(
			GOAL_COMPLETION_CONFIDENCES.map((confidence) => Type.Literal(confidence)),
			{
				description:
					"Self-reported verification basis: guess (none), partial (some), tested (checks pass), or proven (every requirement evidenced). Required for complete; only tested or proven can finish, and neither independently validates correctness.",
			},
		),
	),
	reason: Type.Optional(Type.String()),
})

type UpdateGoalParams = Static<typeof UPDATE_GOAL_PARAMETERS>

type PendingGoalTerminalFeedback = PendingGoalContinuation
type GoalCompletionClaim = PendingGoalContinuation & {
	completionConfidence: "tested" | "proven"
}
type CapturedGoalConversation = PendingGoalContinuation & {
	messages: ReadonlyArray<AgentEndEvent["messages"][number]>
	failed: boolean
}
type GoalTodoState = PendingGoalContinuation & {
	todos: readonly TodoItem[]
	total: number
	blocked: number
	completed: number
	settledStatus?: "complete" | "blocked"
}
const TODO_TOOL_NAME_SET = new Set<string>(TODO_TOOL_NAMES)
const GOAL_TOOL_NAME_SET = new Set<string>(GOAL_TOOL_NAMES)

export default function goalExtension(pi: ExtensionAPI): void {
	if (isAgentWorker()) return

	let currentGoal: GoalState
	const mutationTails = new Map<string, Promise<void>>()
	let currentSessionId: string | undefined
	let pendingContinuation: PendingGoalContinuation | undefined
	let pendingTerminalFeedback: PendingGoalTerminalFeedback | undefined
	let completionClaim: GoalCompletionClaim | undefined
	let capturedConversation: CapturedGoalConversation | undefined
	let activeTurn: PendingGoalContinuation | undefined
	let failedTurn: PendingGoalContinuation | undefined
	let todoStateFor: GoalTodoState | undefined
	let goalLessons: GoalLesson[] = []
	let consecutiveErrorTurns = 0
	let turnStartFingerprint: string | undefined
	let unchangedContinuationTurns = 0
	let substantiveToolUseSinceEvaluation = false
	let activeSinceMs: number | undefined
	// `agent_settled` fires after the run is already marked inactive, so ctx.isIdle()
	// reports idle for the whole evaluator call. Commands that steer a running agent
	// must treat an in-flight evaluation as busy.
	let evaluationAbort: AbortController | undefined
	let statusCtx: ExtensionContext | undefined
	let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined
	const goalWaiters = new Map<string, { promise: Promise<void>; resolve: () => void }>()

	function emitGoalLifecycle(
		event: GoalEventName,
		goal: SessionGoal,
		details: Pick<GoalLifecyclePayload, "reason" | "continuationCount"> = {},
	): void {
		pi.events.emit(event, {
			goalId: goal.id,
			revision: goal.revision,
			status: goal.status,
			tokensUsed: goal.tokensUsed,
			timeUsedMs: goal.timeUsedMs,
			...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
			...(goal.completionConfidence ? { completionConfidence: goal.completionConfidence } : {}),
			...details,
		})
	}

	function serializeGoalMutation<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
		const previous = mutationTails.get(sessionId) ?? Promise.resolve()
		const result = previous.then(operation, operation)
		const tail = result.then(
			() => undefined,
			() => undefined,
		)
		mutationTails.set(sessionId, tail)
		void tail.then(() => {
			if (mutationTails.get(sessionId) === tail) mutationTails.delete(sessionId)
		})
		return result
	}

	function goalWaiterKey(sessionId: string, goalId: string): string {
		return `${sessionId}\0${goalId}`
	}

	function ensureGoalWaiter(sessionId: string, goalId: string): Promise<void> {
		const key = goalWaiterKey(sessionId, goalId)
		const existing = goalWaiters.get(key)
		if (existing) return existing.promise
		let resolve: () => void = () => undefined
		const promise = new Promise<void>((done) => {
			resolve = done
		})
		goalWaiters.set(key, { promise, resolve })
		return promise
	}

	function resolveGoalWaiter(sessionId: string | undefined, goalId: string): void {
		if (!sessionId) return
		const key = goalWaiterKey(sessionId, goalId)
		const waiter = goalWaiters.get(key)
		if (!waiter) return
		goalWaiters.delete(key)
		waiter.resolve()
	}

	function resolveSessionWaiters(sessionId: string | undefined): void {
		if (!sessionId) return
		for (const [key, waiter] of goalWaiters) {
			if (!key.startsWith(`${sessionId}\0`)) continue
			goalWaiters.delete(key)
			waiter.resolve()
		}
	}

	function liveElapsedMs(): number {
		return activeSinceMs === undefined ? 0 : Math.max(0, Date.now() - activeSinceMs)
	}

	function cancelGoalStatusRefresh(): void {
		if (statusRefreshTimer !== undefined) clearTimeout(statusRefreshTimer)
		statusRefreshTimer = undefined
	}

	function clearGoalStatus(): void {
		cancelGoalStatusRefresh()
		statusCtx?.ui.setStatus(GOAL_STATUS_KEY, undefined)
		statusCtx = undefined
	}

	function goalStatusText(): string | undefined {
		const goal = currentGoal
		if (!goal) return undefined
		if (goal.status === "complete") return undefined
		const label =
			goal.status === "active"
				? activeSinceMs === undefined
					? "Goal active"
					: "Goal running"
				: goal.status === "budget_limited"
					? "Goal budget reached"
					: `Goal ${goal.status}`
		return `${label} · ${formatGoalStatusAccounting(goal, liveElapsedMs())}`
	}

	function syncGoalStatus(ctx: ExtensionContext): void {
		statusCtx = ctx
		cancelGoalStatusRefresh()
		if (!ctx.hasUI) return
		const text = goalStatusText()
		ctx.ui.setStatus(GOAL_STATUS_KEY, text)
		const goal = currentGoal
		if (!text || goal?.status !== "active" || activeSinceMs === undefined) return
		const totalMs = goal.timeUsedMs + liveElapsedMs()
		const remainderMs = totalMs % 60_000
		statusRefreshTimer = setTimeout(
			() => {
				statusRefreshTimer = undefined
				if (ctx.sessionManager.getSessionId() === currentSessionId) syncGoalStatus(ctx)
			},
			remainderMs === 0 ? 60_000 : 60_000 - remainderMs,
		)
		statusRefreshTimer.unref()
	}

	function checkpointGoal(goal: SessionGoal, tokensUsed: number, nowMs: number): SessionGoal {
		const startedAt = activeSinceMs
		const elapsed = startedAt === undefined ? 0 : Math.max(0, nowMs - startedAt)
		if (tokensUsed === 0 && elapsed === 0) return goal
		return addGoalAccounting(goal, goal.id, tokensUsed, elapsed, timestamp(nowMs))
	}

	function resetGoalRuntime(): void {
		cancelGoalStatusRefresh()
		pendingContinuation = undefined
		pendingTerminalFeedback = undefined
		completionClaim = undefined
		capturedConversation = undefined
		activeTurn = undefined
		failedTurn = undefined
		todoStateFor = undefined
		goalLessons = []
		consecutiveErrorTurns = 0
		turnStartFingerprint = undefined
		unchangedContinuationTurns = 0
		substantiveToolUseSinceEvaluation = false
		activeSinceMs = undefined
	}

	function bindSession(ctx: ExtensionContext): string {
		const sessionId = ctx.sessionManager.getSessionId()
		if (currentSessionId !== sessionId) replaySession(ctx)
		return sessionId
	}

	function replaySession(ctx: ExtensionContext): void {
		clearGoalStatus()
		// A rewind can land on the same goal id/revision, so the post-await
		// identity check in agent_settled can't tell a stale verdict from a live
		// one. Abort before the state it was judged against is rebuilt below.
		abortEvaluation()
		const previousSessionId = currentSessionId
		// Preserved only when the session itself didn't change (repeated session_start
		// or session_tree replays on an already-attached session), and only re-applied
		// below if it still matches the goal that comes back out of the replay.
		const preservedContinuation =
			previousSessionId === ctx.sessionManager.getSessionId() ? pendingContinuation : undefined
		currentSessionId = ctx.sessionManager.getSessionId()
		if (previousSessionId !== currentSessionId) resolveSessionWaiters(previousSessionId)
		const restored = restoreGoalRuntime(
			ctx.sessionManager.getBranch(),
			currentSessionId,
			getTodoScopeKey(resolveTodoScope()),
		)
		currentGoal = restored.goal
		resetGoalRuntime()
		pendingContinuation = matchesGoal(preservedContinuation, currentGoal, currentSessionId)
			? preservedContinuation
			: undefined
		todoStateFor = restored.todoState
		goalLessons = restored.lessons
		// resetGoalRuntime() just zeroed these along with everything else. The
		// journal already carries the true counts -- both stall guards fold
		// their counter into whichever commit is already happening when it
		// changes (turn_end, agent_settled) -- so re-seed from the restored
		// goal instead of letting a session restart (or the session_start
		// resume kick below, for a crash-loop with no user in the loop) reset a
		// guard that was never actually paused. An explicit /goal resume is the
		// only thing that should zero these against an otherwise-active goal,
		// and it does so by folding the reset into its own commit.
		consecutiveErrorTurns = currentGoal?.consecutiveErrorTurns ?? 0
		unchangedContinuationTurns = currentGoal?.unchangedContinuationTurns ?? 0
		syncGoalStatus(ctx)
	}

	function assertCurrentSession(ctx: ExtensionContext, expectedSessionId: string): void {
		if (currentSessionId !== expectedSessionId || ctx.sessionManager.getSessionId() !== expectedSessionId) {
			throw new Error("The active session changed. Retry the goal command in the current session.")
		}
	}

	function commitGoal(goal: SessionGoal): void {
		const previous = currentGoal
		currentGoal = goal
		try {
			pi.appendEntry(GOAL_CUSTOM_ENTRY_TYPE, putGoalEntry(goal))
		} catch (error) {
			currentGoal = previous
			throw error
		}
		if (previous && previous.id !== goal.id) resolveGoalWaiter(currentSessionId, previous.id)
		if (goal.status !== "active") resolveGoalWaiter(currentSessionId, goal.id)
	}

	function commitClear(goal: SessionGoal): void {
		pi.appendEntry(GOAL_CUSTOM_ENTRY_TYPE, clearGoalEntry(goal, timestamp()))
		currentGoal = clearGoal(goal, goal.id, goal.revision)
		resolveGoalWaiter(currentSessionId, goal.id)
	}

	function goalToolsAvailable(): boolean {
		try {
			const active = new Set(pi.getActiveTools())
			return [...GOAL_TOOL_NAMES, ...TODO_TOOL_NAMES].every((name) => active.has(name))
		} catch {
			return false
		}
	}

	function safeSendControl(
		ctx: ExtensionContext,
		content: string,
		details: Record<string, unknown>,
		deliverAs: "steer" | "followUp" = "steer",
	): boolean {
		if (ctx.sessionManager.getSessionId() !== currentSessionId) return false
		try {
			pi.sendMessage(
				{
					customType: GOAL_CONTROL_MESSAGE_TYPE,
					content,
					display: false,
					details,
				},
				{ triggerTurn: true, deliverAs },
			)
			return true
		} catch (error) {
			if (isStaleCtxError(error)) return false
			throw error
		}
	}

	function queueGoalTurn(
		ctx: ExtensionContext,
		goal: SessionGoal,
		content: string,
		source: string,
		deliverAs: "steer" | "followUp" = "steer",
	): boolean {
		if (!goalToolsAvailable()) return false
		const pending = pendingContinuation
		if (
			pending &&
			pending.sessionId === currentSessionId &&
			pending.goalId === goal.id &&
			pending.revision === goal.revision
		) {
			return false
		}

		pendingContinuation = {
			sessionId: currentSessionId ?? ctx.sessionManager.getSessionId(),
			goalId: goal.id,
			revision: goal.revision,
		}
		const sent = safeSendControl(
			ctx,
			content,
			{
				source,
				goalId: goal.id,
				revision: goal.revision,
			},
			deliverAs,
		)
		if (!sent) pendingContinuation = undefined
		return sent
	}

	function invalidateContinuation(): void {
		pendingContinuation = undefined
		turnStartFingerprint = undefined
		unchangedContinuationTurns = 0
	}

	/**
	 * Drops only the queued-turn marker. The no-progress fingerprint and its
	 * counter survive, because clearing them mid-turn would disarm the stall
	 * guard for the settle that follows.
	 */
	function clearPendingContinuation(): void {
		pendingContinuation = undefined
	}

	/** True while the goal is running or an evaluation is still deciding. */
	function goalIsBusy(ctx: ExtensionContext): boolean {
		if (evaluationAbort) return true
		try {
			return !ctx.isIdle()
		} catch (error) {
			if (isStaleCtxError(error)) return false
			throw error
		}
	}

	/**
	 * Whether a deferred session-start resume kick should stand down: the
	 * session is busy, a message is already queued, or the ctx went stale
	 * (the session was replaced or torn down before the timer fired). A
	 * stale ctx means there is nothing left to resume against, so it counts
	 * as blocked rather than propagating.
	 */
	function goalResumeBlocked(ctx: ExtensionContext): boolean {
		if (goalIsBusy(ctx)) return true
		try {
			return ctx.hasPendingMessages()
		} catch (error) {
			if (isStaleCtxError(error)) return true
			throw error
		}
	}

	function abortEvaluation(): void {
		evaluationAbort?.abort()
		evaluationAbort = undefined
	}

	/**
	 * Whether `goal` is still the one `expected` was captured against, and
	 * nothing has arrived that should take priority over an evaluation:
	 * queued user input, or the goal toolset going unavailable mid-run. Used
	 * both before and after the evaluator call — `goal` differs (a snapshot,
	 * then the freshly re-read current goal) but the check is identical.
	 */
	function canEvaluateGoal(
		expected: PendingGoalContinuation,
		goal: SessionGoal | undefined,
		sessionId: string,
		ctx: ExtensionContext,
	): goal is SessionGoal {
		return (
			goal?.status === "active" &&
			matchesGoal(expected, goal, sessionId) &&
			!ctx.hasPendingMessages() &&
			goalToolsAvailable()
		)
	}

	/**
	 * Called wherever `canEvaluateGoal` just failed, whether before or after
	 * the evaluator ran. Drops `conversation` if it's still the one in
	 * flight, and — only when nothing downstream could ever drive this goal
	 * to a terminal state on its own — releases a headless command still
	 * waiting on it. A goal that stopped being active, changed identity, or
	 * has pending user input is already handled elsewhere (commitGoal,
	 * commitClear, or the turn that the pending input will drive); only the
	 * goal toolset going away leaves nothing else to act.
	 */
	function abandonGoalEvaluation(sessionId: string, conversation: CapturedGoalConversation): void {
		if (capturedConversation === conversation) capturedConversation = undefined
		// Nothing downstream will drive this goal to a terminal state, so a
		// headless command waiting on it would block forever.
		if (!goalToolsAvailable()) resolveGoalWaiter(sessionId, conversation.goalId)
	}

	function assertUnchanged(captured: SessionGoal | undefined): SessionGoal | undefined {
		const current = currentGoal
		if (!captured && !current) return undefined
		if (captured && current?.id === captured.id && current.revision === captured.revision) return current
		throw new Error("The goal changed while this command was open. Retry against the current goal.")
	}

	async function handleSetGoal(
		objective: string,
		tokenBudget: number | undefined,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentGoal
		let terminalWaiter: Promise<void> | undefined
		if (captured && captured.status !== "complete") {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"A goal is already in progress. Replace it from an interactive session or clear it first.",
					"warning",
				)
				return
			}
			const confirmed = await ctx.ui.confirm(
				"Replace current goal?",
				`Replace goal revision ${captured.revision}? This starts a new goal.`,
			)
			if (!confirmed) {
				ctx.ui.notify(`Goal kept: ${captured.objective}`, "info")
				return
			}
		}

		await serializeGoalMutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			assertUnchanged(captured)
			const nowMs = Date.now()
			const now = timestamp(nowMs)
			// An explicit --tokens always wins; the configured default only fills
			// in when the user didn't pass one.
			const effectiveTokenBudget = tokenBudget ?? getGoalSettings().defaultTokenBudget
			const next = captured
				? replaceGoal(objective, randomUUID(), now, effectiveTokenBudget)
				: createGoal(undefined, objective, randomUUID(), now, effectiveTokenBudget)
			commitGoal(next)
			emitGoalLifecycle(captured ? GOAL_EVENTS.REPLACED : GOAL_EVENTS.STARTED, next)
			resetGoalRuntime()
			abortEvaluation()
			syncGoalStatus(ctx)
			// Only block a headless command when a turn is actually running, or
			// nothing would ever resolve the waiter.
			if (queueGoalTurn(ctx, next, buildGoalStartSteer(captured ? "replaced" : "created"), "command") && !ctx.hasUI) {
				terminalWaiter = ensureGoalWaiter(sessionId, next.id)
			}
			ctx.ui.notify(captured ? "Goal replaced." : "Goal created.", "info")
		})
		await terminalWaiter
	}

	async function handleEditGoal(objective: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentGoal
		let terminalWaiter: Promise<void> | undefined
		if (!captured) {
			ctx.ui.notify("No goal is currently set.", "warning")
			return
		}

		let editedObjective = objective
		if (editedObjective === undefined) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Use /goal edit <objective> outside the interactive TUI.", "warning")
				return
			}
			editedObjective = await ctx.ui.editor("Edit goal", captured.objective)
			if (editedObjective === undefined) return
		}

		try {
			await serializeGoalMutation(sessionId, () => {
				assertCurrentSession(ctx, sessionId)
				const current = assertUnchanged(captured)
				if (!current) throw new Error("No goal is currently set.")
				const nowMs = Date.now()
				const now = timestamp(nowMs)
				const accounted = checkpointGoal(current, 0, nowMs)
				const edited = editGoal(accounted, current.id, current.revision, editedObjective, now)
				// An edit already resets both guard counters in-memory below (via
				// invalidateContinuation() and consecutiveErrorTurns = 0); fold that
				// same reset into the committed revision so a later restart doesn't
				// restore a streak that belonged to a superseded objective.
				const next = setGoalUnchangedContinuationTurns(
					setGoalConsecutiveErrorTurns(edited, edited.id, edited.revision, 0, now),
					edited.id,
					edited.revision,
					0,
					now,
				)
				const retainedTodoState =
					todoStateFor && matchesGoal(todoStateFor, current, sessionId)
						? rebindTodoState(todoStateFor, next)
						: undefined
				commitGoal(next)
				emitGoalLifecycle(GOAL_EVENTS.EDITED, next)
				activeSinceMs = current.status === "active" && activeSinceMs !== undefined ? nowMs : undefined
				invalidateContinuation()
				todoStateFor = retainedTodoState
				consecutiveErrorTurns = 0
				abortEvaluation()
				syncGoalStatus(ctx)
				if (
					next.status === "active" &&
					queueGoalTurn(ctx, next, buildGoalEditSteer(next, current.revision), "edit") &&
					!ctx.hasUI
				) {
					terminalWaiter = ensureGoalWaiter(sessionId, next.id)
				}
				ctx.ui.notify(`Goal updated to revision ${next.revision}.`, "info")
			})
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("The goal changed")) {
				ctx.ui.notify(
					"The goal changed while the editor was open. Reopen /goal edit to edit the current revision.",
					"warning",
				)
				return
			}
			throw error
		}
		await terminalWaiter
	}

	async function handlePauseGoal(ctx: ExtensionCommandContext): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentGoal
		if (!captured) return ctx.ui.notify("No goal is currently set.", "warning")
		await serializeGoalMutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			const current = assertUnchanged(captured)
			if (!current) throw new Error("No goal is currently set.")
			if (current.status === "paused") return ctx.ui.notify("Goal is already paused.", "info")
			if (current.status === "budget_limited") {
				return ctx.ui.notify(
					"Goal already stopped at its token budget. Start a replacement goal to continue.",
					"warning",
				)
			}
			if (current.status === "complete") return ctx.ui.notify("A completed goal cannot be paused.", "warning")
			const nowMs = Date.now()
			const accounted = checkpointGoal(current, 0, nowMs)
			const next = setGoalStatus(accounted, current.id, current.revision, "paused", timestamp(nowMs))
			commitGoal(next)
			emitGoalLifecycle(GOAL_EVENTS.PAUSED, next, { reason: "user" })
			activeSinceMs = undefined
			invalidateContinuation()
			const wasBusy = goalIsBusy(ctx)
			abortEvaluation()
			syncGoalStatus(ctx)
			if (wasBusy) {
				safeSendControl(ctx, buildGoalStopSteer("paused"), {
					source: "pause",
					goalId: next.id,
					revision: next.revision,
				})
			}
			ctx.ui.notify("Goal paused.", "info")
		})
	}

	async function handleResumeGoal(ctx: ExtensionCommandContext): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentGoal
		let terminalWaiter: Promise<void> | undefined
		if (!captured) return ctx.ui.notify("No goal is currently set.", "warning")
		await serializeGoalMutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			const current = assertUnchanged(captured)
			if (!current) throw new Error("No goal is currently set.")
			if (current.status === "active") return ctx.ui.notify("Goal is already active.", "info")
			if (current.status === "budget_limited") {
				return ctx.ui.notify("Goal token budget is exhausted. Start a replacement goal with a new budget.", "warning")
			}
			if (current.status === "complete") return ctx.ui.notify("A completed goal cannot be resumed.", "warning")
			const nowMs = Date.now()
			const now = timestamp(nowMs)
			const activated = setGoalStatus(current, current.id, current.revision, "active", now)
			// setGoalStatus refuses "active" and returns budget_limited when tokensUsed
			// already caught up to the budget while paused (e.g. an aborted turn that
			// both blew the budget and forced a pause in the same turn_end). Persist
			// that correction, but don't act as if the resume succeeded: queueing a
			// turn or a headless waiter against a non-active goal would never resolve.
			if (activated.status !== "active") {
				commitGoal(activated)
				syncGoalStatus(ctx)
				ctx.ui.notify("Goal token budget is exhausted. Start a replacement goal with a new budget.", "warning")
				return
			}
			// An explicit resume is the user acknowledging a stall and choosing to
			// continue, so both guard counters are deliberately zeroed here -- unlike
			// a session restart, which must leave them alone. Fold the reset into
			// this same commit so it survives a later restart too.
			const next = setGoalUnchangedContinuationTurns(
				setGoalConsecutiveErrorTurns(activated, activated.id, activated.revision, 0, now),
				activated.id,
				activated.revision,
				0,
				now,
			)
			commitGoal(next)
			invalidateContinuation()
			consecutiveErrorTurns = 0
			syncGoalStatus(ctx)
			if (queueGoalTurn(ctx, next, buildGoalStartSteer("resumed"), "resume") && !ctx.hasUI) {
				terminalWaiter = ensureGoalWaiter(sessionId, next.id)
			}
			ctx.ui.notify("Goal resumed.", "info")
		})
		await terminalWaiter
	}

	async function handleClearGoal(ctx: ExtensionCommandContext): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentGoal
		if (!captured) return ctx.ui.notify("No goal is currently set.", "info")
		await serializeGoalMutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			const current = assertUnchanged(captured)
			if (!current) throw new Error("No goal is currently set.")
			commitClear(current)
			invalidateContinuation()
			todoStateFor = undefined
			goalLessons = []
			activeSinceMs = undefined
			const wasBusy = goalIsBusy(ctx)
			abortEvaluation()
			syncGoalStatus(ctx)
			if (wasBusy) {
				safeSendControl(ctx, buildGoalStopSteer("cleared"), {
					source: "clear",
					goalId: current.id,
					revision: current.revision,
				})
			}
			ctx.ui.notify("Goal cleared.", "info")
		})
	}

	pi.registerTool({
		name: GET_GOAL_TOOL_NAME,
		label: "Get Goal",
		description:
			"Recover the persistent Kimchi session goal only when the canonical goal context is missing or inconsistent.",
		promptSnippet: "Recover missing persistent session goal context",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			bindSession(ctx)
			const current = currentGoal
			const goal = current ? { ...current, timeUsedMs: current.timeUsedMs + liveElapsedMs() } : null
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ goal }, null, 2) }],
				details: { goal },
			}
		},
	})

	pi.registerTool({
		name: UPDATE_GOAL_TOOL_NAME,
		label: "Update Goal",
		description:
			"Claim the active turn's goal is complete, or mark it blocked. A complete claim does not finish the goal: an independent check reads the conversation after the turn settles and decides. Blocked takes effect immediately. Cannot edit, pause, resume, replace, or clear the goal.",
		promptSnippet: "Claim the current goal revision is complete, or mark it blocked",
		promptGuidelines: [
			"Claim complete only after current evidence proves every requirement is met, or report blocked at a real impasse requiring user or external action.",
			"A complete claim is reviewed by a separate check that sees only what this conversation shows. If it disagrees you get its reason and keep working, so surface the evidence in the transcript rather than asserting success.",
			"Repeating an unchanged claim is not progress and will stall the goal. Do new work or gather new evidence before claiming again.",
			"completion_confidence is your reported verification basis for UX and telemetry, not independent proof of correctness.",
			"After the final todo mutation returns its settled result, call update_goal as the only tool call in a later response.",
		],
		parameters: UPDATE_GOAL_PARAMETERS,
		async execute(_toolCallId, params: UpdateGoalParams, _signal, _onUpdate, ctx) {
			const sessionId = bindSession(ctx)
			try {
				const goal = await serializeGoalMutation(sessionId, () => {
					assertCurrentSession(ctx, sessionId)
					if (params.status !== "complete" && params.status !== "blocked") {
						throw new Error(`Goal update rejected: invalid terminal status '${String(params.status)}'.`)
					}
					const current = currentGoal
					if (current?.status !== "active" || !matchesGoal(activeTurn, current, sessionId)) {
						throw new Error(
							"Goal update rejected: the goal changed or stopped during this turn. Continue against the current active goal before updating it.",
						)
					}
					const completionConfidence = params.status === "complete" ? params.completion_confidence : undefined
					if (params.status === "complete" && completionConfidence !== "tested" && completionConfidence !== "proven") {
						throw new Error(
							"Goal completion rejected: reported completion_confidence must be tested or proven. Continue working and gather current evidence before trying again.",
						)
					}
					if (params.status === "complete" && completionConfidence) {
						completionClaim = {
							sessionId,
							goalId: current.id,
							revision: current.revision,
							completionConfidence,
						}
						// The claim is what the agent self-reported, so it belongs to this
						// run's summary. Prompt-summary drains its queue on agent_end,
						// which is before the evaluator has ruled on the claim.
						addPromptSummaryMetric(sessionId, "goal reported verification", completionConfidence)
						// Deliberately not invalidateContinuation(): a claim is not progress,
						// and resetting the fingerprint here would let an agent that keeps
						// claiming completion loop past the no-progress guard forever.
						clearPendingContinuation()
						return current
					}

					const nowMs = Date.now()
					const accounted = checkpointGoal(current, 0, nowMs)
					const next = setGoalStatus(accounted, current.id, current.revision, "blocked", timestamp(nowMs))
					commitGoal(next)
					emitGoalLifecycle(GOAL_EVENTS.BLOCKED, next)
					activeSinceMs = undefined
					invalidateContinuation()
					pendingTerminalFeedback = {
						sessionId,
						goalId: next.id,
						revision: next.revision,
					}
					syncGoalStatus(ctx)
					return next
				})
				return {
					content: [
						{
							type: "text" as const,
							text:
								params.status === "complete"
									? `Goal ${goal.id} revision ${goal.revision} completion claimed. Independent evaluation will run after the agent settles.`
									: `Goal ${goal.id} revision ${goal.revision} marked blocked. Final usage will be shown after this turn is accounted.`,
						},
					],
					details: { goal, reason: params.reason },
					terminate: true,
				}
			} catch (error) {
				const message = errorMessage(error)
				return {
					content: [{ type: "text" as const, text: message }],
					details: { goal: currentGoal ?? null, error: message },
				}
			}
		},
	})

	pi.registerCommand("goal", {
		description: "Set or manage a persistent session goal",
		getArgumentCompletions: (prefix) =>
			GOAL_COMMAND_COMPLETIONS.filter((entry) => entry.startsWith(prefix.toLowerCase())).map((value) => ({
				value: value === "edit" ? "edit " : value,
				label: value,
				description: `/goal ${value}`,
			})),
		handler: async (args, ctx) => {
			try {
				const command = parseGoalCommand(args)
				if (command.action === "show") {
					bindSession(ctx)
					ctx.ui.notify(formatGoalSummary(currentGoal, liveElapsedMs()), "info")
					return
				}
				if (command.action === "set") await handleSetGoal(command.objective, command.tokenBudget, ctx)
				else if (command.action === "edit") await handleEditGoal(command.objective, ctx)
				else if (command.action === "pause") await handlePauseGoal(ctx)
				else if (command.action === "resume") await handleResumeGoal(ctx)
				else await handleClearGoal(ctx)
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "warning")
			}
		},
	})

	pi.on("session_start", (_event, ctx) => {
		replaySession(ctx)
		// A resumed active goal has no in-flight or queued turn (resetGoalRuntime
		// cleared pendingContinuation above), so nothing will ever drive it forward
		// on its own. Kick a continuation unless the normal chat path is about to
		// run a turn anyway.
		//
		// The kick itself must be deferred, not sent from this handler. Embedders
		// (print mode in particular) fully await session_start's dispatch --
		// which runs this handler -- before calling session.prompt() with their
		// own message. hasPendingMessages() is always false at this point
		// regardless: pendingMessageCount is only populated by prompt()/steer()/
		// followUp(), none of which have run yet. If the continuation were sent
		// synchronously here, pi.sendMessage()'s fire-and-forget dispatch starts
		// a real turn immediately (isStreaming is still false during
		// session_start), and that turn can claim the streaming slot before the
		// embedder's own session.prompt() call reaches its isStreaming check --
		// which then throws "Agent is already processing" and aborts the run
		// before the incoming prompt ever executes.
		//
		// Deferring to a macrotask lets any prompt already in flight win that
		// race for real: everything session.prompt() does up to setting
		// isStreaming is synchronous/microtask work, so it completes before this
		// timer's callback runs. goalResumeBlocked re-checks busy/pending state
		// (and the goal identity, in case something else replaced or cleared it
		// in the meantime) when the timer fires, so an incoming prompt -- or any
		// other turn -- skips the kick instead of racing it. Nothing here is
		// awaited and no waiter is created: a session that goes idle-free or
		// tears down before the timer fires just means the kick is skipped, not
		// a hang. queueGoalTurn's existing revision-scoped pendingContinuation
		// guard still makes this idempotent across repeated resumes.
		const goal = currentGoal
		if (goal?.status !== "active") return
		if (!getGoalSettings().autoResume) return
		const sessionId = currentSessionId
		const goalId = goal.id
		const goalRevision = goal.revision
		const resumeKickTimer = setTimeout(() => {
			if (currentSessionId !== sessionId) return
			const latest = currentGoal
			if (latest?.id !== goalId || latest.revision !== goalRevision || latest.status !== "active") return
			if (goalResumeBlocked(ctx)) return
			queueGoalTurn(ctx, latest, buildGoalStartSteer("resumed"), "session_start_resume", "followUp")
		}, 0)
		resumeKickTimer.unref()
	})

	pi.on("session_tree", (_event, ctx) => {
		replaySession(ctx)
	})

	pi.on("context", (event, ctx) => {
		bindSession(ctx)
		const messages = replaceGoalContextMessages(event.messages, currentGoal, goalLessons)
		return messages ? { messages } : undefined
	})

	pi.on("tool_call", (event, ctx) => {
		bindSession(ctx)
		const goal = currentGoal
		if (goal?.status !== "active") return
		if (event.toolName !== UPDATE_GOAL_TOOL_NAME) return
		if (!matchesGoal(activeTurn, goal, currentSessionId)) {
			return {
				block: true,
				reason:
					"The goal changed or stopped during this turn. Continue against the current active goal before calling update_goal.",
			}
		}
		const currentTodoState = matchesGoal(todoStateFor, goal, currentSessionId) ? todoStateFor : undefined
		if (currentTodoState?.total && event.input.status === currentTodoState.settledStatus) return
		return {
			block: true,
			reason:
				"Before ending the goal, keep a visible tactical todo list for this goal revision and settle every item as completed or genuinely blocked. Then call update_goal with the matching status without clearing the list.",
		}
	})

	pi.on("tool_execution_end", (event, ctx) => {
		bindSession(ctx)
		// Only work done under an active goal counts, or tool calls made while the
		// goal is paused make the first turn after /goal resume look productive.
		if (
			currentGoal?.status === "active" &&
			!event.isError &&
			!TODO_TOOL_NAME_SET.has(event.toolName) &&
			!GOAL_TOOL_NAME_SET.has(event.toolName)
		) {
			substantiveToolUseSinceEvaluation = true
		}
		if (event.isError || !TODO_TOOL_NAME_SET.has(event.toolName)) return
		const goal = currentGoal
		const expectedScopeKey = getTodoScopeKey(resolveTodoScope())
		const todoState = todoResultState(event.result, expectedScopeKey)
		if (goal?.status !== "active" || !todoState) return
		const previous = matchesGoal(todoStateFor, goal, currentSessionId) ? todoStateFor : undefined
		goalLessons = updateGoalLessons(goalLessons, todoState.todos)
		todoStateFor = {
			sessionId: currentSessionId ?? ctx.sessionManager.getSessionId(),
			goalId: goal.id,
			revision: goal.revision,
			...todoState,
			settledStatus: deriveSettledStatus(todoState, previous?.settledStatus),
		}
	})

	pi.on("turn_start", (_event, ctx) => {
		bindSession(ctx)
		failedTurn = undefined
		if (pendingContinuation?.sessionId === ctx.sessionManager.getSessionId()) {
			pendingContinuation = undefined
		}
		const goal = currentGoal
		if (goal?.status === "active") {
			activeSinceMs ??= Date.now()
			activeTurn = { sessionId: ctx.sessionManager.getSessionId(), goalId: goal.id, revision: goal.revision }
			const todoState = matchesGoal(todoStateFor, goal, currentSessionId) ? todoStateFor : undefined
			turnStartFingerprint = goalProgressFingerprint(goal, todoState, goalLessons)
		} else {
			activeTurn = undefined
			turnStartFingerprint = undefined
		}
		syncGoalStatus(ctx)
	})

	pi.on("turn_end", async (event, ctx) => {
		const sessionId = bindSession(ctx)
		await serializeGoalMutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			const attribution = activeTurn
			activeTurn = undefined
			const current = currentGoal
			if (attribution?.sessionId === sessionId && current?.id === attribution.goalId) {
				const nowMs = Date.now()
				const now = timestamp(nowMs)
				const accounted = checkpointGoal(current, assistantTurnTokens(event), nowMs)
				const reachedBudget = current.status === "active" && accounted.status === "budget_limited"
				const interruption = current.status === "active" ? assistantTurnInterruption(event) : undefined
				failedTurn = interruption ? { sessionId, goalId: current.id, revision: current.revision } : undefined
				if (interruption === "error") consecutiveErrorTurns += 1
				else consecutiveErrorTurns = 0
				// Folded into whatever commit this turn already produces (accounting
				// alone, or the pause below): setGoalConsecutiveErrorTurns is a
				// no-op when the count didn't change, so this never adds a commit on
				// its own -- see setGoalConsecutiveErrorTurns's doc comment.
				const withErrorTurns = setGoalConsecutiveErrorTurns(
					accounted,
					current.id,
					current.revision,
					consecutiveErrorTurns,
					now,
				)
				const { maxConsecutiveErrors } = getGoalSettings()
				const terminalInterruption =
					interruption === "aborted" || consecutiveErrorTurns >= maxConsecutiveErrors ? interruption : undefined
				const next = terminalInterruption
					? setGoalStatus(withErrorTurns, current.id, current.revision, "paused", now)
					: withErrorTurns
				if (next !== current) commitGoal(next)
				activeSinceMs = undefined
				if (terminalInterruption) {
					emitGoalLifecycle(GOAL_EVENTS.PAUSED, next, {
						reason: terminalInterruption === "aborted" ? "agent_aborted" : "agent_errors",
					})
					invalidateContinuation()
					ctx.ui.notify(
						terminalInterruption === "aborted"
							? "Goal paused because the agent turn was cancelled."
							: `Goal paused after ${maxConsecutiveErrors} consecutive agent errors.`,
						"warning",
					)
				} else if (reachedBudget) {
					invalidateContinuation()
					ctx.ui.notify(
						`Goal stopped after reaching its ${formatCount(accounted.tokenBudget ?? 0)} token budget.`,
						"warning",
					)
				}
				syncGoalStatus(ctx)
			}

			const feedback = pendingTerminalFeedback
			if (feedback && matchesGoal(feedback, currentGoal, sessionId)) {
				ctx.ui.notify("Goal blocked.", "warning")
				pendingTerminalFeedback = undefined
			}
		})
	})

	pi.on("agent_end", (event, ctx) => {
		const sessionId = bindSession(ctx)
		const goal = currentGoal
		capturedConversation =
			goal?.status === "active"
				? {
						sessionId,
						goalId: goal.id,
						revision: goal.revision,
						messages: event.messages,
						failed: matchesGoal(failedTurn, goal, sessionId),
					}
				: undefined
	})

	pi.on("agent_settled", async (_event, ctx) => {
		const sessionId = bindSession(ctx)
		const capturedGoal = currentGoal
		const conversation = capturedConversation
		if (!conversation) return
		if (!canEvaluateGoal(conversation, capturedGoal, sessionId, ctx)) {
			abandonGoalEvaluation(sessionId, conversation)
			return
		}
		if (conversation.failed) {
			capturedConversation = undefined
			queueGoalTurn(ctx, capturedGoal, buildGoalErrorContinuation(), "agent_error", "followUp")
			return
		}
		const capturedTodoState = matchesGoal(todoStateFor, capturedGoal, sessionId) ? todoStateFor : undefined
		const hadSubstantiveToolUse = substantiveToolUseSinceEvaluation
		const startFingerprint = turnStartFingerprint
		evaluationAbort = new AbortController()
		const abort = evaluationAbort
		let result: GoalEvaluationResult
		try {
			result = await evaluateGoal(
				{
					objective: capturedGoal.objective,
					messages: conversation.messages,
					todos: capturedTodoState?.todos ?? [],
					signal: abort.signal,
				},
				ctx,
			)
		} finally {
			if (evaluationAbort === abort) evaluationAbort = undefined
		}
		// Pause, clear and shutdown abort the evaluation; their own handling wins.
		if (abort.signal.aborted) return

		await serializeGoalMutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			const goal = currentGoal
			if (!canEvaluateGoal(conversation, goal, sessionId, ctx)) {
				abandonGoalEvaluation(sessionId, conversation)
				return
			}
			const now = timestamp()
			const evaluation: GoalEvaluation = {
				verdict: result.verdict,
				reason: result.reason,
				...(result.model ? { model: result.model } : {}),
				evaluatedAt: now,
			}
			const evaluated = recordGoalEvaluation(goal, goal.id, goal.revision, evaluation, result.usage, now)
			capturedConversation = undefined
			substantiveToolUseSinceEvaluation = false

			const emitEvaluation = (recorded: SessionGoal): void => {
				if (result.verdict === "unavailable" || !result.usage) return
				pi.events.emit(GOAL_EVENTS.EVALUATED, {
					goalId: recorded.id,
					verdict: result.verdict,
					count: recorded.evaluationCount ?? 1,
					model: result.model,
					// This evaluation's own usage, not the goal's running total: the
					// event is per-evaluation and consumers sum it.
					usage: result.usage,
				})
			}

			if (result.verdict === "unavailable") {
				const paused = setGoalStatus(evaluated, evaluated.id, evaluated.revision, "paused", now)
				commitGoal(paused)
				emitGoalLifecycle(GOAL_EVENTS.PAUSED, paused, { reason: "evaluator_unavailable" })
				completionClaim = undefined
				activeSinceMs = undefined
				invalidateContinuation()
				syncGoalStatus(ctx)
				ctx.ui.notify(`Goal paused: ${result.reason}`, "warning")
				return
			}

			if (result.verdict === "impossible") {
				const blocked = setGoalStatus(evaluated, evaluated.id, evaluated.revision, "blocked", now)
				commitGoal(blocked)
				emitEvaluation(blocked)
				emitGoalLifecycle(GOAL_EVENTS.BLOCKED, blocked)
				completionClaim = undefined
				activeSinceMs = undefined
				invalidateContinuation()
				syncGoalStatus(ctx)
				ctx.ui.notify(`Goal blocked: ${result.reason}`, "warning")
				return
			}

			const todoState = matchesGoal(todoStateFor, evaluated, sessionId) ? todoStateFor : undefined
			if (result.verdict === "met" && todoState?.total && todoState.settledStatus === "complete") {
				const claim = matchesGoal(completionClaim, evaluated, sessionId) ? completionClaim : undefined
				const completed = {
					...setGoalStatus(evaluated, evaluated.id, evaluated.revision, "complete", now),
					...(claim ? { completionConfidence: claim.completionConfidence } : {}),
				}
				commitGoal(completed)
				emitEvaluation(completed)
				emitGoalLifecycle(GOAL_EVENTS.COMPLETED, completed)
				completionClaim = undefined
				activeSinceMs = undefined
				invalidateContinuation()
				syncGoalStatus(ctx)
				ctx.ui.notify("Goal complete.", "info")
				return
			}

			// The claim survives a `continue`: it is scoped to this goal revision by
			// matchesGoal, and dropping it would lose the reported verification basis
			// when a later turn is the one the evaluator accepts.
			const continuationReason =
				result.verdict === "met"
					? "The evaluator found the objective met, but the current Goal revision still needs a visible, fully completed Todo list."
					: result.reason
			const fingerprint = goalProgressFingerprint(evaluated, todoState, goalLessons)
			const { maxUnchangedContinuations } = getGoalSettings()
			const unchanged = !hadSubstantiveToolUse && fingerprint === startFingerprint ? unchangedContinuationTurns + 1 : 0
			// Folded into the single commit below either way (setGoalUnchangedContinuationTurns
			// is a no-op when the count didn't change). This is recorded even on the rare path
			// where queueGoalTurn then fails to actually queue a turn: canEvaluateGoal already
			// confirmed goal tools are available and the session is current with no await in
			// between, so that failure is not a meaningfully different outcome here, and
			// deferring the fold until after queueGoalTurn would mean either a second commit
			// (breaking the "one commit per turn" invariant other tests pin) or committing
			// after queueGoalTurn's pi.sendMessage(triggerTurn) may have already synchronously
			// started the next turn against a stale currentGoal.
			const withContinuationCount = setGoalUnchangedContinuationTurns(
				evaluated,
				evaluated.id,
				evaluated.revision,
				unchanged,
				now,
			)
			if (unchanged >= maxUnchangedContinuations) {
				const paused = setGoalStatus(
					withContinuationCount,
					withContinuationCount.id,
					withContinuationCount.revision,
					"paused",
					now,
				)
				commitGoal(paused)
				emitEvaluation(paused)
				emitGoalLifecycle(GOAL_EVENTS.STALLED, paused, {
					reason: "no_progress",
					continuationCount: unchanged,
				})
				activeSinceMs = undefined
				invalidateContinuation()
				syncGoalStatus(ctx)
				ctx.ui.notify(
					`Goal paused after ${maxUnchangedContinuations} unchanged continuation turns without substantive tool use.`,
					"warning",
				)
				return
			}

			commitGoal(withContinuationCount)
			emitEvaluation(withContinuationCount)
			if (
				queueGoalTurn(
					ctx,
					withContinuationCount,
					buildGoalContinuation(unchanged > 0, continuationReason),
					"evaluation",
					"followUp",
				)
			) {
				unchangedContinuationTurns = unchanged
			} else {
				// No turn was queued, so nothing will drive this goal further; release
				// any headless command still waiting on a terminal state.
				resolveGoalWaiter(sessionId, withContinuationCount.id)
			}
			syncGoalStatus(ctx)
		})
	})

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.sessionManager.getSessionId() !== currentSessionId) return
		abortEvaluation()
		resolveSessionWaiters(currentSessionId)
		clearGoalStatus()
		currentSessionId = undefined
		resetGoalRuntime()
		currentGoal = undefined
	})
}

function matchesGoal(
	marker: PendingGoalContinuation | undefined,
	goal: SessionGoal | undefined,
	sessionId: string | undefined,
): goal is SessionGoal {
	return Boolean(
		marker && goal && marker.sessionId === sessionId && marker.goalId === goal.id && marker.revision === goal.revision,
	)
}

function restoreGoalRuntime(
	entries: readonly SessionEntry[],
	sessionId: string,
	expectedScopeKey: string,
): { goal: GoalState; todoState: GoalTodoState | undefined; lessons: GoalLesson[] } {
	const goalEntries: unknown[] = []
	let goal: GoalState
	let todoState: GoalTodoState | undefined
	let lessons: GoalLesson[] = []

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === GOAL_CUSTOM_ENTRY_TYPE) {
			const previous = goal
			goalEntries.push(entry.data)
			goal = restoreGoal(goalEntries)
			if (!sameGoalRevision(previous, goal)) {
				if (previous && goal && previous.id === goal.id) {
					if (todoState) todoState = rebindTodoState(todoState, goal)
				} else {
					todoState = undefined
					lessons = []
				}
			}
		}

		const details = getWriteTodosDetails(entry)
		if (!goal || !details || getTodoScopeKey(normalizeTodoScope(details.scope)) !== expectedScopeKey) continue
		lessons = updateGoalLessons(lessons, details.todos)
		const counts = todoCounts(details.todos)
		todoState = {
			sessionId,
			goalId: goal.id,
			revision: goal.revision,
			todos: details.todos,
			...counts,
			settledStatus: deriveSettledStatus(counts, todoState?.settledStatus),
		}
	}

	return { goal, todoState, lessons }
}

function sameGoalRevision(left: GoalState, right: GoalState): boolean {
	return left?.id === right?.id && left?.revision === right?.revision
}

function todoCounts(todos: readonly unknown[]): Pick<GoalTodoState, "total" | "blocked" | "completed"> {
	const counts = { total: todos.length, blocked: 0, completed: 0 }
	for (const todo of todos) {
		if (!isRecord(todo)) continue
		if (todo.status === "blocked") counts.blocked += 1
		else if (todo.status === "completed") counts.completed += 1
	}
	return counts
}

/**
 * A settled empty list carries no verdict of its own — an item that was just
 * cleared should not silently overwrite the previous settled status, so an
 * empty count keeps whatever the list last settled to.
 */
function deriveSettledStatus(
	counts: Pick<GoalTodoState, "total" | "blocked" | "completed">,
	previousSettledStatus: GoalTodoState["settledStatus"],
): GoalTodoState["settledStatus"] {
	if (counts.total === 0) return previousSettledStatus
	if (counts.completed === counts.total) return "complete"
	if (counts.blocked > 0 && counts.completed + counts.blocked === counts.total) return "blocked"
	return undefined
}

function rebindTodoState(state: GoalTodoState, goal: SessionGoal): GoalTodoState {
	return {
		sessionId: state.sessionId,
		goalId: goal.id,
		revision: goal.revision,
		todos: state.todos,
		total: state.total,
		blocked: state.blocked,
		completed: state.completed,
	}
}

/**
 * A turn that only appends a fresh, not-yet-started todo must not look like
 * progress: the prompt now actively invites adding a todo the moment new
 * work is discovered, so mere list growth is reachable from an agent that is
 * merely confused ("add a todo, plan, add a todo, plan"), not just a
 * malicious one. Excluding "pending" items means a newly added item
 * contributes nothing to the fingerprint until it is actually started or
 * settled -- at which point its (now non-pending) tuple appears for the
 * first time and the fingerprint changes, which is a real state transition.
 *
 * Per-item identity is kept (rather than folding in only aggregate counts)
 * so two transitions that happen to cancel out in aggregate -- e.g. one item
 * settling from blocked to completed while another settles the other way in
 * the same turn -- still register as progress.
 *
 * Sorted by id for determinism: the todos store already returns items in id
 * order (see orderTodosForStorage in todos/reducer.ts), but sorting here
 * keeps this function self-contained and pure with respect to its inputs --
 * a pure reorder or rename of otherwise-unchanged items must not look like
 * progress, and this function shouldn't have to trust an invariant
 * maintained in a different module to stay order-stable.
 */
function goalProgressFingerprint(
	goal: SessionGoal,
	todoState: GoalTodoState | undefined,
	lessons: readonly GoalLesson[],
): string {
	const todos = todoState
		? [...todoState.todos]
				.filter((todo) => todo.status !== "pending")
				.sort((a, b) => a.id - b.id)
				.map(({ id, status, activeForm }) => [id, status, activeForm?.trim() ?? null])
		: []
	const durableLessons = lessons.map(({ todoId, kind, text }) => [todoId, kind, text])
	return JSON.stringify([goal.id, goal.revision, todos, durableLessons])
}

function assistantTurnTokens(event: TurnEndEvent): number {
	if (event.message.role !== "assistant") return 0
	const usage = event.message.usage
	const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)
	const total = Number.isFinite(usage?.totalTokens)
		? usage.totalTokens
		: finite(usage?.input) + finite(usage?.output) + finite(usage?.cacheRead) + finite(usage?.cacheWrite)
	return Math.max(0, Math.round(total))
}

function todoResultState(
	result: unknown,
	expectedScopeKey: string,
): Pick<GoalTodoState, "todos" | "total" | "blocked" | "completed"> | undefined {
	if (!isRecord(result) || !isWriteTodosDetails(result.details)) return undefined
	const details = result.details
	try {
		if (getTodoScopeKey(normalizeTodoScope(details.scope)) !== expectedScopeKey) return undefined
	} catch {
		return undefined
	}

	return { todos: details.todos, ...todoCounts(details.todos) }
}

function assistantTurnInterruption(event: TurnEndEvent): "aborted" | "error" | undefined {
	if (event.message.role !== "assistant") return undefined
	return event.message.stopReason === "aborted" || event.message.stopReason === "error"
		? event.message.stopReason
		: undefined
}

function timestamp(now = Date.now()): string {
	return new Date(now).toISOString()
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
