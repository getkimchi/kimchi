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
import { errorMessage } from "../error-message.js"
import { formatCount } from "../format.js"
import { addPromptSummaryMetric } from "../prompt-summary.js"
import { isStaleCtxError } from "../stale-ctx.js"
import { getTodoScopeKey, normalizeTodoScope } from "../todos/scope.js"
import { getWriteTodosDetails, isWriteTodosDetails } from "../todos/session.js"
import { resolveTodoScope } from "../todos/store.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import type { TodoItem } from "../todos/types.js"
import { formatGoalAccounting, formatGoalSummary, GOAL_COMMAND_COMPLETIONS, parseGoalCommand } from "./command.js"
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
	putGoalEvaluatorUsageEntry,
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
	type GoalCompletionConfidence,
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
					"Optional self-reported verification basis: guess (none), partial (some), tested (checks pass), or proven (every requirement evidenced). The independent evaluator still decides whether the goal is complete.",
			},
		),
	),
	reason: Type.Optional(Type.String()),
})

type UpdateGoalParams = Static<typeof UPDATE_GOAL_PARAMETERS>

type GoalCompletionClaim = PendingGoalContinuation & {
	completionConfidence?: GoalCompletionConfidence
}

class StaleGoalCommandError extends Error {}

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
	let pendingTerminalFeedback: PendingGoalContinuation | undefined
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
		return `${label} · ${formatGoalAccounting(goal, liveElapsedMs())}`
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
		// Abort before replay rebuilds state: a rewind can reuse the same goal id/revision.
		abortEvaluation()
		const previousSessionId = currentSessionId
		// Preserve a pending continuation only for the same session, then revalidate it
		// against the replayed goal below.
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
		// Restore persisted guard counters; session replay must not reset them.
		// Explicit /goal resume resets them in its own commit.
		consecutiveErrorTurns = currentGoal?.consecutiveErrorTurns ?? 0
		unchangedContinuationTurns = currentGoal?.unchangedContinuationTurns ?? 0
		syncGoalStatus(ctx)
	}

	function assertCurrentSession(ctx: ExtensionContext, expectedSessionId: string): void {
		if (currentSessionId !== expectedSessionId || ctx.sessionManager.getSessionId() !== expectedSessionId) {
			throw new Error("The active session changed. Retry the goal command in the current session.")
		}
	}

	function commitGoal(goal: SessionGoal, resolveTerminalWaiter = true): void {
		const previous = currentGoal
		currentGoal = goal
		try {
			pi.appendEntry(GOAL_CUSTOM_ENTRY_TYPE, putGoalEntry(goal))
		} catch (error) {
			currentGoal = previous
			throw error
		}
		if (previous && previous.id !== goal.id) resolveGoalWaiter(currentSessionId, previous.id)
		if (resolveTerminalWaiter && goal.status !== "active") resolveGoalWaiter(currentSessionId, goal.id)
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

	function notifyGoalToolsUnavailable(ctx: ExtensionCommandContext): void {
		ctx.ui.notify("Goal requires the Goal and Todo tools to be enabled before it can run.", "warning")
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

	/** True only while the coding agent itself is running. */
	function agentTurnIsBusy(ctx: ExtensionContext): boolean {
		try {
			return !ctx.isIdle()
		} catch (error) {
			if (isStaleCtxError(error)) return false
			throw error
		}
	}

	/** True while the goal is running or an evaluation is still deciding. */
	function goalIsBusy(ctx: ExtensionContext): boolean {
		return Boolean(evaluationAbort) || agentTurnIsBusy(ctx)
	}

	/**
	 * Whether a deferred session-start resume kick should stand down: the
	 * session is busy, a message is already queued, or the ctx went stale
	 * (the session was replaced or torn down before the timer fired). A
	 * stale ctx means there is nothing left to resume against, so it counts
	 * as blocked rather than propagating.
	 */
	function goalResumeBlocked(ctx: ExtensionContext): boolean {
		return goalIsBusy(ctx) || goalHasPendingMessages(ctx)
	}

	function goalHasPendingMessages(ctx: ExtensionContext): boolean {
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

	/** Evaluate only the current active goal with no pending input and available tools. */
	function canEvaluateGoal(
		expected: PendingGoalContinuation,
		goal: SessionGoal | undefined,
		sessionId: string,
		ctx: ExtensionContext,
	): goal is SessionGoal {
		return (
			goal?.status === "active" &&
			matchesGoal(expected, goal, sessionId) &&
			!goalHasPendingMessages(ctx) &&
			goalToolsAvailable()
		)
	}

	/** Drop stale evaluation state and release headless waiters only when tools cannot resume the goal. */
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
		throw new StaleGoalCommandError("The goal changed while this command was open. Retry against the current goal.")
	}

	async function handleSetGoal(
		objective: string,
		tokenBudget: number | undefined,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentGoal
		let terminalWaiter: Promise<void> | undefined
		if (!goalToolsAvailable()) {
			notifyGoalToolsUnavailable(ctx)
			return
		}
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
			if (error instanceof StaleGoalCommandError) {
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
			const wasBusy = agentTurnIsBusy(ctx)
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
			if (!goalToolsAvailable()) {
				notifyGoalToolsUnavailable(ctx)
				return
			}
			const nowMs = Date.now()
			const now = timestamp(nowMs)
			const activated = setGoalStatus(current, current.id, current.revision, "active", now)
			// Persist a budget-limited correction without queueing a non-active goal.
			if (activated.status !== "active") {
				commitGoal(activated)
				syncGoalStatus(ctx)
				ctx.ui.notify("Goal token budget is exhausted. Start a replacement goal with a new budget.", "warning")
				return
			}
			// Explicit resume resets both persisted guard counters in this commit; replay preserves them.
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
			const wasBusy = agentTurnIsBusy(ctx)
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
			"Claim complete only after current evidence proves every requirement is met. Report blocked only when the objective cannot be completed without user or external action after trying viable alternatives; one unavailable preferred tool or check is not a blockage.",
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
					if (params.status === "complete") {
						completionClaim = {
							sessionId,
							goalId: current.id,
							revision: current.revision,
							...(completionConfidence ? { completionConfidence } : {}),
						}
						// The claim is what the agent self-reported, so it belongs to this
						// run's summary. Prompt-summary drains its queue on agent_end,
						// which is before the evaluator has ruled on the claim.
						if (completionConfidence) {
							addPromptSummaryMetric(sessionId, "goal reported verification", completionConfidence)
						}
						// Deliberately not invalidateContinuation(): a claim is not progress,
						// and resetting the fingerprint here would let an agent that keeps
						// claiming completion loop past the no-progress guard forever.
						clearPendingContinuation()
						return current
					}

					const nowMs = Date.now()
					const accounted = checkpointGoal(current, 0, nowMs)
					const next = setGoalStatus(
						accounted,
						current.id,
						current.revision,
						"blocked",
						timestamp(nowMs),
						params.reason,
					)
					commitGoal(next, false)
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
		// Defer a resumed goal's kick so an embedder's incoming prompt wins the
		// streaming-slot race; the timer rechecks busy, pending, and goal identity.
		// No waiter is held open, and pendingContinuation keeps repeated resumes idempotent.
		const goal = currentGoal
		if (goal?.status !== "active") return
		if (!getGoalSettings().autoResume) return
		if (!ctx.hasUI) return
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
		if (event.input.status === "blocked") return
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
			const pendingFeedback = pendingTerminalFeedback
			const deferTerminalWaiter = pendingFeedback !== undefined && matchesGoal(pendingFeedback, current, sessionId)
			if (attribution?.sessionId === sessionId && current?.id === attribution.goalId) {
				const nowMs = Date.now()
				const now = timestamp(nowMs)
				const accounted = checkpointGoal(current, assistantTurnTokens(event), nowMs)
				const reachedBudget = current.status === "active" && accounted.status === "budget_limited"
				const interruption = current.status === "active" ? assistantTurnInterruption(event) : undefined
				failedTurn = interruption ? { sessionId, goalId: current.id, revision: current.revision } : undefined
				// Retry attempts can each emit turn_end before one agent_settled. Keep
				// the existing streak until that run settles; only a completed run can
				// contribute one consecutive error.
				const withErrorTurns = setGoalConsecutiveErrorTurns(
					accounted,
					current.id,
					current.revision,
					interruption === "error" ? consecutiveErrorTurns : 0,
					now,
				)
				const terminalInterruption = interruption === "aborted" ? interruption : undefined
				const next = terminalInterruption
					? setGoalStatus(withErrorTurns, current.id, current.revision, "paused", now)
					: withErrorTurns
				if (next !== current) commitGoal(next, !deferTerminalWaiter)
				activeSinceMs = undefined
				if (terminalInterruption) {
					emitGoalLifecycle(GOAL_EVENTS.PAUSED, next, {
						reason: terminalInterruption === "aborted" ? "agent_aborted" : "agent_errors",
					})
					invalidateContinuation()
					ctx.ui.notify("Goal paused because the agent turn was cancelled.", "warning")
				} else if (reachedBudget) {
					invalidateContinuation()
					ctx.ui.notify(
						`Goal stopped after reaching its ${formatCount(accounted.tokenBudget ?? 0)} token budget.`,
						"warning",
					)
				}
				syncGoalStatus(ctx)
			}

			if (pendingFeedback && matchesGoal(pendingFeedback, currentGoal, sessionId)) {
				ctx.ui.notify("Goal blocked.", "warning")
				pendingTerminalFeedback = undefined
				resolveGoalWaiter(sessionId, pendingFeedback.goalId)
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
			const now = timestamp()
			const settledErrors = consecutiveErrorTurns + 1
			const withErrorTurns = setGoalConsecutiveErrorTurns(
				capturedGoal,
				capturedGoal.id,
				capturedGoal.revision,
				settledErrors,
				now,
			)
			const { maxConsecutiveErrors } = getGoalSettings()
			capturedConversation = undefined
			if (settledErrors >= maxConsecutiveErrors) {
				const paused = setGoalStatus(withErrorTurns, withErrorTurns.id, withErrorTurns.revision, "paused", now)
				commitGoal(paused)
				consecutiveErrorTurns = settledErrors
				emitGoalLifecycle(GOAL_EVENTS.PAUSED, paused, { reason: "agent_errors" })
				invalidateContinuation()
				ctx.ui.notify(`Goal paused after ${maxConsecutiveErrors} consecutive agent errors.`, "warning")
				syncGoalStatus(ctx)
				return
			}
			commitGoal(withErrorTurns)
			consecutiveErrorTurns = settledErrors
			if (!queueGoalTurn(ctx, withErrorTurns, buildGoalErrorContinuation(), "agent_error", "followUp")) {
				resolveGoalWaiter(sessionId, withErrorTurns.id)
			}
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
					lessons: goalLessons,
					signal: abort.signal,
				},
				ctx,
			)
		} finally {
			if (evaluationAbort === abort) evaluationAbort = undefined
		}
		if (currentSessionId !== sessionId || ctx.sessionManager.getSessionId() !== sessionId) return
		await serializeGoalMutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			if (result.usage) {
				pi.appendEntry(
					GOAL_CUSTOM_ENTRY_TYPE,
					putGoalEvaluatorUsageEntry(sessionId, conversation.goalId, conversation.revision, result.usage),
				)
			}
			// Input/tool availability or cancellation can invalidate the verdict, but not its billable usage.
			if (abort.signal.aborted) return
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
					// Emit this evaluation's usage; consumers sum per-evaluation events.
					usage: result.usage,
				})
			}

			// Commit before evaluation/lifecycle events; both consume the committed goal.
			const recordTerminalOutcome = (
				goal: SessionGoal,
				event: GoalEventName,
				notify: { message: string; level: "info" | "warning" },
				options: {
					details?: Pick<GoalLifecyclePayload, "reason" | "continuationCount">
					skipEvaluationEvent?: boolean
					keepCompletionClaim?: boolean
				} = {},
			): void => {
				commitGoal(goal)
				if (!options.skipEvaluationEvent) emitEvaluation(goal)
				emitGoalLifecycle(event, goal, options.details)
				if (!options.keepCompletionClaim) completionClaim = undefined
				activeSinceMs = undefined
				invalidateContinuation()
				syncGoalStatus(ctx)
				ctx.ui.notify(notify.message, notify.level)
			}

			if (result.verdict === "unavailable") {
				const paused = setGoalStatus(evaluated, evaluated.id, evaluated.revision, "paused", now)
				recordTerminalOutcome(
					paused,
					GOAL_EVENTS.PAUSED,
					{ message: `Goal paused: ${result.reason}`, level: "warning" },
					{ details: { reason: "evaluator_unavailable" }, skipEvaluationEvent: true },
				)
				return
			}

			if (result.verdict === "impossible") {
				const blocked = setGoalStatus(evaluated, evaluated.id, evaluated.revision, "blocked", now, result.reason)
				recordTerminalOutcome(blocked, GOAL_EVENTS.BLOCKED, {
					message: `Goal blocked: ${result.reason}`,
					level: "warning",
				})
				return
			}

			const todoState = matchesGoal(todoStateFor, evaluated, sessionId) ? todoStateFor : undefined
			if (result.verdict === "met" && todoState?.total && todoState.settledStatus === "complete") {
				const claim = matchesGoal(completionClaim, evaluated, sessionId) ? completionClaim : undefined
				const completed = {
					...setGoalStatus(evaluated, evaluated.id, evaluated.revision, "complete", now),
					...(claim?.completionConfidence ? { completionConfidence: claim.completionConfidence } : {}),
				}
				recordTerminalOutcome(completed, GOAL_EVENTS.COMPLETED, { message: "Goal complete.", level: "info" })
				return
			}

			// Keep the claim across continue; it remains scoped to this goal revision.
			const continuationReason =
				result.verdict === "met"
					? "The evaluator found the objective met, but the current Goal revision still needs a visible, fully completed Todo list."
					: result.reason
			const fingerprint = goalProgressFingerprint(evaluated, todoState, goalLessons)
			const { maxUnchangedContinuations } = getGoalSettings()
			const unchanged = !hadSubstantiveToolUse && fingerprint === startFingerprint ? unchangedContinuationTurns + 1 : 0
			// Folded into the single commit below (a no-op if unchanged) rather than committed
			// separately after queueGoalTurn: that would mean two commits per turn, and by then
			// queueGoalTurn's pi.sendMessage(triggerTurn) may already have raced a synchronously-started next turn.
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
				recordTerminalOutcome(
					paused,
					GOAL_EVENTS.STALLED,
					{
						message: `Goal paused after ${maxUnchangedContinuations} unchanged continuation turns without substantive tool use.`,
						level: "warning",
					},
					{
						details: { reason: "no_progress", continuationCount: unchanged },
						keepCompletionClaim: true,
					},
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
 * Ignore pending-only additions; progress begins when an item starts or settles.
 * Canonicalize identity-keyed items so display-only reordering is not progress.
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
				.map(({ id, status, content, activeForm, note }) => [
					id,
					status,
					content,
					activeForm?.trim() ?? null,
					note?.trim() ?? null,
				])
		: []
	const durableLessons = [...lessons]
		.sort((a, b) => a.todoId - b.todoId)
		.map(({ todoId, kind, text }) => [todoId, kind, text])
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
