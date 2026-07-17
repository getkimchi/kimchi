import { randomUUID } from "node:crypto"
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import { isAgentWorker } from "../agent-worker-context.js"
import { formatCount } from "../format.js"
import { isStaleCtxError } from "../stale-ctx.js"
import { getTodoScopeKey, normalizeTodoScope } from "../todos/scope.js"
import { resolveTodoScope } from "../todos/store.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import {
	formatGoalAccounting,
	formatGoalStatusAccounting,
	formatGoalSummary,
	GOAL_COMMAND_COMPLETIONS,
	parseGoalCommand,
} from "./command.js"
import {
	GET_GOAL_TOOL_NAME,
	GOAL_CONTROL_MESSAGE_TYPE,
	GOAL_CUSTOM_ENTRY_TYPE,
	GOAL_STATUS_KEY,
	GOAL_TOOL_NAMES,
	UPDATE_GOAL_TOOL_NAME,
} from "./constants.js"
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
	requireCurrentGoal,
	restoreGoal,
	setGoalStatus,
} from "./reducer.js"
import type { GoalStatus, GoalTurnAttribution, PendingGoalContinuation, SessionGoal } from "./types.js"

const UPDATE_GOAL_PARAMETERS = Type.Object({
	goalId: Type.String(),
	revision: Type.Integer({ minimum: 1 }),
	status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
	reason: Type.Optional(Type.String()),
})

interface UpdateGoalParams {
	goalId: string
	revision: number
	status: "complete" | "blocked"
	reason?: string
}

type PendingGoalTerminalFeedback = GoalTurnAttribution & { status: "complete" | "blocked" }
type GoalTodoState = GoalTurnAttribution & {
	total: number
	blocked: number
	completed: number
	settledStatus?: "complete" | "blocked"
}
const TODO_TOOL_NAME_SET = new Set<string>(TODO_TOOL_NAMES)

export default function goalExtension(pi: ExtensionAPI): void {
	if (isAgentWorker()) return

	let currentGoal: GoalState
	const mutationTails = new Map<string, Promise<void>>()
	let currentSessionId: string | undefined
	let pendingContinuation: PendingGoalContinuation | undefined
	let pendingTerminalFeedback: PendingGoalTerminalFeedback | undefined
	let activeTurn: GoalTurnAttribution | undefined
	let todoStateFor: GoalTodoState | undefined
	let activeSinceMs: number | undefined
	let statusCtx: ExtensionContext | undefined
	let statusRefreshTimer: ReturnType<typeof setTimeout> | undefined

	function serializeGoalMutation<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
		const previous = mutationTails.get(sessionId) ?? Promise.resolve()
		const result = previous.then(operation, operation)
		mutationTails.set(
			sessionId,
			result.then(
				() => undefined,
				() => undefined,
			),
		)
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
		if (!goal || goal.status === "complete") return undefined
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

	function checkpointGoal(goal: SessionGoal, tokensUsed: number, nowMs: number, keepRunning: boolean): SessionGoal {
		const startedAt = activeSinceMs
		const elapsed = startedAt === undefined ? 0 : Math.max(0, nowMs - startedAt)
		activeSinceMs = keepRunning && startedAt !== undefined ? nowMs : undefined
		if (tokensUsed === 0 && elapsed === 0) return goal
		return addGoalAccounting(goal, goal.id, tokensUsed, elapsed, timestamp(nowMs))
	}

	function resetGoalRuntime(): void {
		cancelGoalStatusRefresh()
		pendingContinuation = undefined
		pendingTerminalFeedback = undefined
		activeTurn = undefined
		todoStateFor = undefined
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
		const entries: unknown[] = []
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === GOAL_CUSTOM_ENTRY_TYPE) entries.push(entry.data)
		}
		currentGoal = restoreGoal(entries)
		resetGoalRuntime()
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
				? replaceGoal(captured, objective, randomUUID(), now, tokenBudget)
				: createGoal(undefined, objective, randomUUID(), now, tokenBudget)
			commitGoal(next)
			resetGoalRuntime()
			syncGoalStatus(ctx)
			queueGoalTurn(ctx, next, buildGoalStartSteer(next, captured ? "replaced" : "created"), "command")
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
				const accounted = checkpointGoal(current, 0, nowMs, current.status === "active")
				const next = editGoal(accounted, current.id, current.revision, editedObjective, timestamp(nowMs))
				commitGoal(next)
				invalidateContinuation()
				todoStateFor = undefined
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
			const accounted = checkpointGoal(current, 0, nowMs, false)
			const next = setGoalStatus(accounted, current.id, current.revision, "paused", timestamp(nowMs))
			commitGoal(next)
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
			syncGoalStatus(ctx)
			queueGoalTurn(ctx, next, buildGoalStartSteer(next, "resumed"), "resume")
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
		description: "Read the current persistent Kimchi session goal, including its ID, revision, objective, and status.",
		promptSnippet: "Read the current persistent session goal",
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
			"Mark the current goal revision complete or blocked. Requires the exact current goal ID and revision and cannot edit, pause, resume, replace, or clear the goal.",
		promptSnippet: "Mark the current goal revision complete or blocked",
		promptGuidelines: [
			"Use update_goal only after current evidence proves every requirement is complete, or at a real impasse requiring user or external action.",
			"Always pass the exact goal ID and revision from the current goal context.",
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
					const current = requireCurrentGoal(currentGoal, params.goalId, params.revision)
					const nowMs = Date.now()
					const accounted = checkpointGoal(current, 0, nowMs, false)
					const next = setGoalStatus(
						accounted,
						params.goalId,
						params.revision,
						params.status as GoalStatus,
						timestamp(nowMs),
					)
					commitGoal(next)
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
				if (command.action === "set") return await handleSetGoal(command.objective, command.tokenBudget, ctx)
				if (command.action === "edit") return await handleEditGoal(command.objective, ctx)
				if (command.action === "pause") return await handlePauseGoal(ctx)
				if (command.action === "resume") return await handleResumeGoal(ctx)
				await handleClearGoal(ctx)
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
		if (event.toolName === GET_GOAL_TOOL_NAME || TODO_TOOL_NAME_SET.has(event.toolName)) return
		const currentTodoState = matchesGoal(todoStateFor, goal, currentSessionId) ? todoStateFor : undefined
		if (event.toolName === UPDATE_GOAL_TOOL_NAME && currentTodoState) {
			if (currentTodoState.total === 0 && event.input.status === currentTodoState.settledStatus) {
				return
			}
			return {
				block: true,
				reason:
					"Reconcile the tactical todo list before ending the goal: settle every item as completed or genuinely blocked, then clear the fully settled list before update_goal.",
			}
		}
		if (currentTodoState && currentTodoState.total > 0) return
		return {
			block: true,
			reason:
				"Goal mode requires a visible tactical todo list for this goal revision. Use create_todos or another todo tool to create or reconcile the list before calling other tools.",
		}
	})

	pi.on("tool_execution_end", (event, ctx) => {
		if (event.isError || !TODO_TOOL_NAME_SET.has(event.toolName)) return
		const sessionId = bindSession(ctx)
		const goal = currentGoal
		const expectedScopeKey = getTodoScopeKey(resolveTodoScope(undefined, sessionId))
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
				const accounted = checkpointGoal(current, assistantTurnTokens(event), nowMs, false)
				const reachedBudget = current.status === "active" && accounted.status === "budget_limited"
				const interruption = current.status === "active" ? assistantTurnInterruption(event) : undefined
				const next = interruption
					? setGoalStatus(accounted, current.id, current.revision, "paused", timestamp(nowMs))
					: accounted
				if (next !== current) commitGoal(next)
				if (interruption) {
					invalidateContinuation()
					ctx.ui.notify(
						interruption === "aborted"
							? "Goal paused because the agent turn was cancelled."
							: "Goal paused because the agent turn stopped with an error.",
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
				ctx.ui.notify(
					`Goal ${feedback.status} in ${formatGoalAccounting(goalAfterAccounting)}.`,
					feedback.status === "blocked" ? "warning" : "info",
				)
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
			queueGoalTurn(ctx, goal, buildGoalContinuation(goal), "agent_end", "followUp")
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
	marker: GoalTurnAttribution | undefined,
	goal: SessionGoal | undefined,
	sessionId: string | undefined,
): goal is SessionGoal {
	return Boolean(
		marker && goal && marker.sessionId === sessionId && marker.goalId === goal.id && marker.revision === goal.revision,
	)
}

function assistantTurnTokens(event: TurnEndEvent): number {
	if (event.message.role !== "assistant") return 0
	const usage = event.message.usage
	const total = Number.isFinite(usage.totalTokens)
		? usage.totalTokens
		: usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
	return Math.max(0, Math.round(total))
}

function todoResultState(
	result: unknown,
	expectedScopeKey: string,
): Pick<GoalTodoState, "total" | "blocked" | "completed"> | undefined {
	if (
		!isRecord(result) ||
		!isRecord(result.details) ||
		result.details.scope === undefined ||
		!Array.isArray(result.details.todos) ||
		getTodoScopeKey(normalizeTodoScope(result.details.scope)) !== expectedScopeKey
	) {
		return undefined
	}

	const state = { total: result.details.todos.length, blocked: 0, completed: 0 }
	for (const todo of result.details.todos) {
		if (!isRecord(todo)) continue
		if (todo.status === "blocked") state.blocked += 1
		else if (todo.status === "completed") state.completed += 1
	}
	return state
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
