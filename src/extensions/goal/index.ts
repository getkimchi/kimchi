import { randomUUID } from "node:crypto"
import type {
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
import { getWriteTodosDetails } from "../todos/session.js"
import { resolveTodoScope } from "../todos/store.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import { formatGoalStatusAccounting, formatGoalSummary, GOAL_COMMAND_COMPLETIONS, parseGoalCommand } from "./command.js"
import {
	GET_GOAL_TOOL_NAME,
	GOAL_CONTROL_MESSAGE_TYPE,
	GOAL_CUSTOM_ENTRY_TYPE,
	GOAL_STATUS_KEY,
	GOAL_TOOL_NAMES,
	UPDATE_GOAL_TOOL_NAME,
} from "./constants.js"
import { GOAL_EVENTS, type GoalEventName } from "./domain-events.js"
import {
	buildGoalContinuation,
	buildGoalEditSteer,
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
	putGoalEntry,
	replaceGoal,
	restoreGoal,
	setGoalStatus,
} from "./reducer.js"
import { GOAL_COMPLETION_CONFIDENCES, type PendingGoalContinuation, type SessionGoal } from "./types.js"

const UPDATE_GOAL_PARAMETERS = Type.Object({
	status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
	completion_confidence: Type.Optional(
		Type.Union(
			GOAL_COMPLETION_CONFIDENCES.map((confidence) => Type.Literal(confidence)),
			{
				description:
					"Completion evidence: guess (none), partial (some), tested (checks pass), or proven (every requirement evidenced). Required for complete; only tested or proven can finish.",
			},
		),
	),
	reason: Type.Optional(Type.String()),
})

type UpdateGoalParams = Static<typeof UPDATE_GOAL_PARAMETERS>

type PendingGoalTerminalFeedback = PendingGoalContinuation & { status: "complete" | "blocked" }
type GoalTodoState = PendingGoalContinuation & {
	total: number
	blocked: number
	completed: number
	settledStatus?: "complete" | "blocked"
}
const TODO_TOOL_NAME_SET = new Set<string>(TODO_TOOL_NAMES)
const MAX_CONSECUTIVE_ERROR_TURNS = 3

export default function goalExtension(pi: ExtensionAPI): void {
	if (isAgentWorker()) return

	let currentGoal: GoalState
	const mutationTails = new Map<string, Promise<void>>()
	let currentSessionId: string | undefined
	let pendingContinuation: PendingGoalContinuation | undefined
	let pendingTerminalFeedback: PendingGoalTerminalFeedback | undefined
	let activeTurn: PendingGoalContinuation | undefined
	let todoStateFor: GoalTodoState | undefined
	let consecutiveErrorTurns = 0
	let activeSinceMs: number | undefined
	let statusCtx: ExtensionContext | undefined
	let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined

	function emitGoalLifecycle(event: GoalEventName, goal: SessionGoal): void {
		pi.events.emit(event, {
			goalId: goal.id,
			revision: goal.revision,
			status: goal.status,
			tokensUsed: goal.tokensUsed,
			timeUsedMs: goal.timeUsedMs,
			...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
			...(goal.completionConfidence ? { completionConfidence: goal.completionConfidence } : {}),
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
		if (!goal) return "Goal ready"
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
		activeTurn = undefined
		todoStateFor = undefined
		consecutiveErrorTurns = 0
		activeSinceMs = undefined
	}

	function bindSession(ctx: ExtensionContext): string {
		const sessionId = ctx.sessionManager.getSessionId()
		if (currentSessionId !== sessionId) replaySession(ctx)
		return sessionId
	}

	function replaySession(ctx: ExtensionContext): void {
		clearGoalStatus()
		currentSessionId = ctx.sessionManager.getSessionId()
		const restored = restoreGoalRuntime(
			ctx.sessionManager.getBranch(),
			currentSessionId,
			getTodoScopeKey(resolveTodoScope()),
		)
		currentGoal = restored.goal
		resetGoalRuntime()
		todoStateFor = restored.todoState
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
	}

	function commitClear(goal: SessionGoal): void {
		pi.appendEntry(GOAL_CUSTOM_ENTRY_TYPE, clearGoalEntry(goal, timestamp()))
		currentGoal = clearGoal(goal, goal.id, goal.revision)
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
			const next = captured
				? replaceGoal(objective, randomUUID(), now, tokenBudget)
				: createGoal(undefined, objective, randomUUID(), now, tokenBudget)
			commitGoal(next)
			emitGoalLifecycle(captured ? GOAL_EVENTS.REPLACED : GOAL_EVENTS.STARTED, next)
			resetGoalRuntime()
			syncGoalStatus(ctx)
			queueGoalTurn(ctx, next, buildGoalStartSteer(captured ? "replaced" : "created"), "command")
			ctx.ui.notify(captured ? "Goal replaced." : "Goal created.", "info")
		})
	}

	async function handleEditGoal(objective: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentGoal
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
				const accounted = checkpointGoal(current, 0, nowMs)
				const next = editGoal(accounted, current.id, current.revision, editedObjective, timestamp(nowMs))
				commitGoal(next)
				emitGoalLifecycle(GOAL_EVENTS.EDITED, next)
				activeSinceMs = current.status === "active" && activeSinceMs !== undefined ? nowMs : undefined
				invalidateContinuation()
				todoStateFor = undefined
				consecutiveErrorTurns = 0
				syncGoalStatus(ctx)
				if (next.status === "active") {
					queueGoalTurn(ctx, next, buildGoalEditSteer(next, current.revision), "edit")
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
			activeSinceMs = undefined
			invalidateContinuation()
			syncGoalStatus(ctx)
			if (!ctx.isIdle()) {
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
			const next = setGoalStatus(current, current.id, current.revision, "active", timestamp(nowMs))
			commitGoal(next)
			invalidateContinuation()
			consecutiveErrorTurns = 0
			syncGoalStatus(ctx)
			queueGoalTurn(ctx, next, buildGoalStartSteer("resumed"), "resume")
			ctx.ui.notify("Goal resumed.", "info")
		})
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
			activeSinceMs = undefined
			syncGoalStatus(ctx)
			if (!ctx.isIdle()) {
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
		description: "Mark the active turn's goal complete or blocked. Cannot edit, pause, resume, replace, or clear it.",
		promptSnippet: "Mark the current goal revision complete or blocked",
		promptGuidelines: [
			"Use update_goal only after current evidence proves every requirement is complete, or at a real impasse requiring user or external action.",
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
							"Goal completion rejected: completion_confidence must be tested or proven. Continue working and gather current evidence before trying again.",
						)
					}
					const nowMs = Date.now()
					const accounted = checkpointGoal(current, 0, nowMs)
					const next = {
						...setGoalStatus(accounted, current.id, current.revision, params.status, timestamp(nowMs)),
						...(completionConfidence ? { completionConfidence } : {}),
					}
					commitGoal(next)
					emitGoalLifecycle(params.status === "complete" ? GOAL_EVENTS.COMPLETED : GOAL_EVENTS.BLOCKED, next)
					activeSinceMs = undefined
					invalidateContinuation()
					pendingTerminalFeedback = {
						sessionId,
						goalId: next.id,
						revision: next.revision,
						status: params.status,
					}
					syncGoalStatus(ctx)
					return next
				})
				return {
					content: [
						{
							type: "text" as const,
							text: `Goal ${goal.id} revision ${goal.revision} marked ${goal.status}. Final usage will be shown after this turn is accounted.`,
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
				if (!ctx.hasUI) await ctx.waitForIdle()
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "warning")
			}
		},
	})

	pi.on("session_start", (_event, ctx) => {
		replaySession(ctx)
	})

	pi.on("session_tree", (_event, ctx) => {
		replaySession(ctx)
	})

	pi.on("context", (event, ctx) => {
		bindSession(ctx)
		const messages = replaceGoalContextMessages(event.messages, currentGoal)
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
		if (event.isError || !TODO_TOOL_NAME_SET.has(event.toolName)) return
		bindSession(ctx)
		const goal = currentGoal
		const expectedScopeKey = getTodoScopeKey(resolveTodoScope())
		const todoState = todoResultState(event.result, expectedScopeKey)
		if (goal?.status !== "active" || !todoState) return
		const previous = matchesGoal(todoStateFor, goal, currentSessionId) ? todoStateFor : undefined
		const settledStatus =
			todoState.total === 0
				? previous?.settledStatus
				: todoState.completed === todoState.total
					? "complete"
					: todoState.blocked > 0 && todoState.completed + todoState.blocked === todoState.total
						? "blocked"
						: undefined
		todoStateFor = {
			sessionId: currentSessionId ?? ctx.sessionManager.getSessionId(),
			goalId: goal.id,
			revision: goal.revision,
			...todoState,
			settledStatus,
		}
	})

	pi.on("turn_start", (_event, ctx) => {
		bindSession(ctx)
		if (pendingContinuation?.sessionId === ctx.sessionManager.getSessionId()) {
			pendingContinuation = undefined
		}
		const goal = currentGoal
		if (goal?.status === "active") {
			activeSinceMs ??= Date.now()
			activeTurn = { sessionId: ctx.sessionManager.getSessionId(), goalId: goal.id, revision: goal.revision }
		} else {
			activeTurn = undefined
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
				const accounted = checkpointGoal(current, assistantTurnTokens(event), nowMs)
				const reachedBudget = current.status === "active" && accounted.status === "budget_limited"
				const interruption = current.status === "active" ? assistantTurnInterruption(event) : undefined
				if (interruption === "error") consecutiveErrorTurns += 1
				else consecutiveErrorTurns = 0
				const terminalInterruption =
					interruption === "aborted" || consecutiveErrorTurns >= MAX_CONSECUTIVE_ERROR_TURNS ? interruption : undefined
				const next = terminalInterruption
					? setGoalStatus(accounted, current.id, current.revision, "paused", timestamp(nowMs))
					: accounted
				if (next !== current) commitGoal(next)
				activeSinceMs = undefined
				if (terminalInterruption) {
					invalidateContinuation()
					ctx.ui.notify(
						terminalInterruption === "aborted"
							? "Goal paused because the agent turn was cancelled."
							: `Goal paused after ${MAX_CONSECUTIVE_ERROR_TURNS} consecutive agent errors.`,
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

			const goalAfterAccounting = currentGoal
			const feedback = pendingTerminalFeedback
			if (feedback && matchesGoal(feedback, goalAfterAccounting, sessionId)) {
				if (goalAfterAccounting.completionConfidence) {
					addPromptSummaryMetric(sessionId, "goal confidence", goalAfterAccounting.completionConfidence)
				}
				ctx.ui.notify(`Goal ${feedback.status}.`, feedback.status === "blocked" ? "warning" : "info")
				pendingTerminalFeedback = undefined
			}
		})
	})

	pi.on("agent_end", async (_event, ctx) => {
		const sessionId = bindSession(ctx)
		await serializeGoalMutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			const goal = currentGoal
			if (goal?.status !== "active" || ctx.hasPendingMessages() || !goalToolsAvailable()) return
			queueGoalTurn(ctx, goal, buildGoalContinuation(), "agent_end", "followUp")
		})
	})

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.sessionManager.getSessionId() !== currentSessionId) return
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
): { goal: GoalState; todoState: GoalTodoState | undefined } {
	const goalEntries: unknown[] = []
	let goal: GoalState
	let todoState: GoalTodoState | undefined

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === GOAL_CUSTOM_ENTRY_TYPE) {
			const previous = goal
			goalEntries.push(entry.data)
			goal = restoreGoal(goalEntries)
			if (!sameGoalRevision(previous, goal)) todoState = undefined
		}

		const details = getWriteTodosDetails(entry)
		if (!goal || !details || getTodoScopeKey(normalizeTodoScope(details.scope)) !== expectedScopeKey) continue
		const counts = todoCounts(details.todos)
		todoState = {
			sessionId,
			goalId: goal.id,
			revision: goal.revision,
			...counts,
			settledStatus:
				counts.total === 0
					? todoState?.settledStatus
					: counts.completed === counts.total
						? "complete"
						: counts.blocked > 0 && counts.completed + counts.blocked === counts.total
							? "blocked"
							: undefined,
		}
	}

	return { goal, todoState }
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
): Pick<GoalTodoState, "total" | "blocked" | "completed"> | undefined {
	if (!isRecord(result) || !isRecord(result.details) || !Array.isArray(result.details.todos)) {
		return undefined
	}
	try {
		if (getTodoScopeKey(normalizeTodoScope(result.details.scope)) !== expectedScopeKey) return undefined
	} catch {
		return undefined
	}

	return todoCounts(result.details.todos)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object"
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
