import { randomUUID } from "node:crypto"
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent"
import { buildSessionContext } from "@earendil-works/pi-coding-agent"
import { type Static, Type } from "typebox"
import { isAgentWorker } from "../agent-worker-context.js"
import { formatCount } from "../format.js"
import { isStaleCtxError } from "../stale-ctx.js"
import { registerTodoCommandMutationHandler } from "../todos/command-mutation.js"
import { getTodoScopeKey, normalizeTodoScope } from "../todos/scope.js"
import { getWriteTodosDetails, isWriteTodosDetails } from "../todos/session.js"
import { GLOBAL_TODO_SCOPE, getTodosForScope, resolveTodoScope } from "../todos/store.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import type { TodoItem } from "../todos/types.js"
import { FERMENT_V2_COMMAND_COMPLETIONS, formatFermentV2Summary, parseFermentV2Command } from "./command.js"
import {
	FERMENT_V2_COMMAND_NAME,
	FERMENT_V2_CONTROL_MESSAGE_TYPE,
	FERMENT_V2_CUSTOM_ENTRY_TYPE,
	FERMENT_V2_TOOL_NAMES,
	GET_FERMENT_V2_TOOL_NAME,
	UPDATE_FERMENT_V2_TOOL_NAME,
} from "./constants.js"
import { FERMENT_V2_EVENTS, type FermentV2EventName, type FermentV2LifecyclePayload } from "./domain-events.js"
import { evaluateFermentV2, type FermentV2EvaluationResult } from "./evaluator.js"
import { type FermentV2Lesson, updateFermentV2Lessons } from "./lessons.js"
import {
	buildFermentV2Continuation,
	buildFermentV2EditSteer,
	buildFermentV2ErrorContinuation,
	buildFermentV2StartSteer,
	replaceFermentV2ContextMessages,
} from "./prompt.js"
import {
	addFermentV2Accounting,
	clearFermentV2,
	clearFermentV2Entry,
	createFermentV2,
	editFermentV2,
	type FermentV2State,
	isRecord,
	putFermentV2Entry,
	recordFermentV2Evaluation,
	replaceFermentV2,
	restoreFermentV2,
	setFermentV2ConsecutiveErrorTurns,
	setFermentV2Status,
	setFermentV2UnchangedContinuationTurns,
} from "./reducer.js"
import { getFermentV2Settings } from "./settings.js"
import {
	FERMENT_V2_COMPLETION_CONFIDENCES,
	type FermentV2CompletionConfidence,
	type FermentV2Evaluation,
	type PendingFermentV2Continuation,
	type SessionFermentV2,
} from "./types.js"

const UPDATE_FERMENT_V2_PARAMETERS = Type.Object({
	status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
	completion_confidence: Type.Optional(
		Type.Union(
			FERMENT_V2_COMPLETION_CONFIDENCES.map((confidence) => Type.Literal(confidence)),
			{
				description:
					"Optional self-reported verification basis: guess (none), partial (some), tested (checks pass), or proven (every requirement evidenced). The independent evaluator still decides whether the Ferment V2 is complete.",
			},
		),
	),
	reason: Type.Optional(Type.String()),
})

type UpdateFermentV2Params = Static<typeof UPDATE_FERMENT_V2_PARAMETERS>

type FermentV2CompletionClaim = PendingFermentV2Continuation & {
	completionConfidence?: FermentV2CompletionConfidence
}

class StaleFermentV2CommandError extends Error {}

type CapturedFermentV2Conversation = PendingFermentV2Continuation & {
	messages: ReadonlyArray<AgentEndEvent["messages"][number]>
	failed: boolean
}
type FermentV2TodoState = PendingFermentV2Continuation & {
	todos: readonly TodoItem[]
	total: number
	blocked: number
	completed: number
	settledStatus?: "complete" | "blocked"
}
const TODO_TOOL_NAME_SET = new Set<string>(TODO_TOOL_NAMES)
const FERMENT_V2_TOOL_NAME_SET = new Set<string>(FERMENT_V2_TOOL_NAMES)

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export default function fermentV2Extension(pi: ExtensionAPI): void {
	if (isAgentWorker()) return

	let currentFermentV2: FermentV2State
	const mutationTails = new Map<string, Promise<void>>()
	let currentSessionId: string | undefined
	let pendingContinuation: PendingFermentV2Continuation | undefined
	let pendingTerminalFeedback: PendingFermentV2Continuation | undefined
	let completionClaim: FermentV2CompletionClaim | undefined
	let capturedConversation: CapturedFermentV2Conversation | undefined
	let activeTurn: PendingFermentV2Continuation | undefined
	let pendingUserMutation: PendingFermentV2Continuation | undefined
	let failedTurn: PendingFermentV2Continuation | undefined
	let todoStateFor: FermentV2TodoState | undefined
	let fermentV2Lessons: FermentV2Lesson[] = []
	let turnStartFingerprint: string | undefined
	let substantiveToolUseSinceEvaluation = false
	let activeSinceMs: number | undefined
	// `agent_settled` fires after the run is already marked inactive, so ctx.isIdle()
	// reports idle for the whole evaluator call. Commands that steer a running agent
	// must treat an in-flight evaluation as busy.
	let evaluationAbort: AbortController | undefined
	let evaluationSettled: Promise<void> | undefined
	let unregisterTodoCommandMutationHandler: (() => void) | undefined
	const fermentV2Waiters = new Map<string, { promise: Promise<void>; resolve: () => void }>()

	function emitFermentV2Lifecycle(
		event: FermentV2EventName,
		fermentV2: SessionFermentV2,
		details: Pick<FermentV2LifecyclePayload, "reason" | "continuationCount"> = {},
	): void {
		pi.events.emit(event, {
			fermentV2Id: fermentV2.id,
			revision: fermentV2.revision,
			status: fermentV2.status,
			tokensUsed: fermentV2.tokensUsed,
			timeUsedMs: fermentV2.timeUsedMs,
			...(fermentV2.tokenBudget !== undefined ? { tokenBudget: fermentV2.tokenBudget } : {}),
			...(fermentV2.completionConfidence ? { completionConfidence: fermentV2.completionConfidence } : {}),
			...details,
		})
	}

	function serializeFermentV2Mutation<T>(sessionId: string, operation: () => Promise<T> | T): Promise<T> {
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

	function fermentV2WaiterKey(sessionId: string, fermentV2Id: string): string {
		return `${sessionId}\0${fermentV2Id}`
	}

	function ensureFermentV2Waiter(sessionId: string, fermentV2Id: string): Promise<void> {
		const key = fermentV2WaiterKey(sessionId, fermentV2Id)
		const existing = fermentV2Waiters.get(key)
		if (existing) return existing.promise
		let resolve: () => void = () => undefined
		const promise = new Promise<void>((done) => {
			resolve = done
		})
		fermentV2Waiters.set(key, { promise, resolve })
		return promise
	}

	function resolveFermentV2Waiter(sessionId: string | undefined, fermentV2Id: string): void {
		if (!sessionId) return
		const key = fermentV2WaiterKey(sessionId, fermentV2Id)
		const waiter = fermentV2Waiters.get(key)
		if (!waiter) return
		fermentV2Waiters.delete(key)
		waiter.resolve()
	}

	function resolveSessionWaiters(sessionId: string | undefined): void {
		if (!sessionId) return
		for (const [key, waiter] of fermentV2Waiters) {
			if (!key.startsWith(`${sessionId}\0`)) continue
			fermentV2Waiters.delete(key)
			waiter.resolve()
		}
	}

	function liveElapsedMs(): number {
		return activeSinceMs === undefined ? 0 : Math.max(0, Date.now() - activeSinceMs)
	}

	function checkpointFermentV2(fermentV2: SessionFermentV2, tokensUsed: number, nowMs: number): SessionFermentV2 {
		const startedAt = activeSinceMs
		const elapsed = startedAt === undefined ? 0 : Math.max(0, nowMs - startedAt)
		if (tokensUsed === 0 && elapsed === 0) return fermentV2
		return addFermentV2Accounting(fermentV2, fermentV2.id, tokensUsed, elapsed, timestamp(nowMs))
	}

	function resetFermentV2Runtime(): void {
		pendingContinuation = undefined
		pendingTerminalFeedback = undefined
		completionClaim = undefined
		capturedConversation = undefined
		activeTurn = undefined
		pendingUserMutation = undefined
		failedTurn = undefined
		todoStateFor = undefined
		fermentV2Lessons = []
		turnStartFingerprint = undefined
		substantiveToolUseSinceEvaluation = false
		activeSinceMs = undefined
	}

	function bindSession(ctx: ExtensionContext): string {
		const sessionId = ctx.sessionManager.getSessionId()
		if (currentSessionId !== sessionId) replaySession(ctx)
		return sessionId
	}

	function replaySession(ctx: ExtensionContext): void {
		// Abort before replay rebuilds state: a rewind can reuse the same Ferment V2 id/revision.
		void abortEvaluation()
		const previousSessionId = currentSessionId
		// Preserve a pending continuation only for the same session, then revalidate it
		// against the replayed Ferment V2 below.
		const preservedContinuation =
			previousSessionId === ctx.sessionManager.getSessionId() ? pendingContinuation : undefined
		currentSessionId = ctx.sessionManager.getSessionId()
		if (previousSessionId !== currentSessionId) resolveSessionWaiters(previousSessionId)
		unregisterTodoCommandMutationHandler?.()
		unregisterTodoCommandMutationHandler = registerTodoCommandMutationHandler(
			currentSessionId,
			handleTodoCommandMutation,
		)
		const restored = restoreFermentV2Runtime(
			ctx.sessionManager.getBranch(),
			currentSessionId,
			getTodoScopeKey(resolveTodoScope()),
		)
		currentFermentV2 = restored.fermentV2
		resetFermentV2Runtime()
		pendingContinuation = matchesFermentV2(preservedContinuation, currentFermentV2, currentSessionId)
			? preservedContinuation
			: undefined
		todoStateFor = restored.todoState
		fermentV2Lessons = restored.lessons
	}

	function assertCurrentSession(ctx: ExtensionContext, expectedSessionId: string): void {
		if (currentSessionId !== expectedSessionId || ctx.sessionManager.getSessionId() !== expectedSessionId) {
			throw new Error("The active session changed. Retry the Ferment V2 command in the current session.")
		}
	}

	function commitFermentV2(fermentV2: SessionFermentV2, resolveTerminalWaiter = true): void {
		const previous = currentFermentV2
		currentFermentV2 = fermentV2
		try {
			pi.appendEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, putFermentV2Entry(fermentV2))
		} catch (error) {
			currentFermentV2 = previous
			throw error
		}
		if (previous && previous.id !== fermentV2.id) resolveFermentV2Waiter(currentSessionId, previous.id)
		if (resolveTerminalWaiter && fermentV2.status !== "active") resolveFermentV2Waiter(currentSessionId, fermentV2.id)
	}

	function commitClear(fermentV2: SessionFermentV2): void {
		pi.appendEntry(FERMENT_V2_CUSTOM_ENTRY_TYPE, clearFermentV2Entry(fermentV2, timestamp()))
		currentFermentV2 = clearFermentV2(fermentV2, fermentV2.id, fermentV2.revision)
		resolveFermentV2Waiter(currentSessionId, fermentV2.id)
	}

	function fermentV2ToolsAvailable(): boolean {
		try {
			const active = new Set(pi.getActiveTools())
			return [...FERMENT_V2_TOOL_NAMES, ...TODO_TOOL_NAMES].every((name) => active.has(name))
		} catch {
			return false
		}
	}

	function notifyFermentV2ToolsUnavailable(ctx: ExtensionCommandContext): void {
		ctx.ui.notify("Ferment V2 requires the Ferment V2 and Todo tools to be enabled before it can run.", "warning")
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
					customType: FERMENT_V2_CONTROL_MESSAGE_TYPE,
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

	function queueFermentV2Turn(
		ctx: ExtensionContext,
		fermentV2: SessionFermentV2,
		content: string,
		source: string,
		deliverAs: "steer" | "followUp" = "steer",
	): boolean {
		if (!fermentV2ToolsAvailable()) return false
		const pending = pendingContinuation
		if (
			pending &&
			pending.sessionId === currentSessionId &&
			pending.fermentV2Id === fermentV2.id &&
			pending.revision === fermentV2.revision
		) {
			return false
		}

		pendingContinuation = {
			sessionId: currentSessionId ?? ctx.sessionManager.getSessionId(),
			fermentV2Id: fermentV2.id,
			revision: fermentV2.revision,
		}
		const sent = safeSendControl(
			ctx,
			content,
			{
				source,
				fermentV2Id: fermentV2.id,
				revision: fermentV2.revision,
			},
			deliverAs,
		)
		if (!sent) pendingContinuation = undefined
		return sent
	}

	function queueFermentV2TurnAfterSettled(
		ctx: ExtensionContext,
		fermentV2: SessionFermentV2,
		content: string,
		source: string,
	): void {
		const sessionId = currentSessionId
		if (!sessionId) return
		const expected: PendingFermentV2Continuation = {
			sessionId,
			fermentV2Id: fermentV2.id,
			revision: fermentV2.revision,
		}
		setTimeout(() => {
			const current = currentFermentV2
			if (
				currentSessionId !== sessionId ||
				current?.status !== "active" ||
				current.id !== expected.fermentV2Id ||
				current.revision !== expected.revision ||
				agentTurnIsBusy(ctx) ||
				fermentV2HasPendingMessages(ctx)
			)
				return
			if (pendingContinuation && matchesFermentV2(pendingContinuation, current, sessionId)) return
			if (!queueFermentV2Turn(ctx, current, content, source, "followUp")) {
				resolveFermentV2Waiter(sessionId, current.id)
			}
		}, 0)
	}

	function invalidateContinuation(): void {
		pendingContinuation = undefined
		turnStartFingerprint = undefined
	}

	/**
	 * Drops only the queued-turn marker. The no-progress fingerprint and its
	 * counter survive, because clearing them mid-turn would disarm the stall
	 * guard for the settle that follows.
	 */
	function clearPendingContinuation(): void {
		pendingContinuation = undefined
	}

	function agentTurnIsBusy(ctx: ExtensionContext): boolean {
		try {
			return !ctx.isIdle()
		} catch (error) {
			if (isStaleCtxError(error)) return false
			throw error
		}
	}

	function fermentV2IsBusy(ctx: ExtensionContext): boolean {
		return Boolean(evaluationAbort) || agentTurnIsBusy(ctx)
	}

	/**
	 * Whether a deferred session-start resume kick should stand down: the
	 * session is busy, a message is already queued, or the ctx went stale
	 * (the session was replaced or torn down before the timer fired). A
	 * stale ctx means there is nothing left to resume against, so it counts
	 * as blocked rather than propagating.
	 */
	function fermentV2ResumeBlocked(ctx: ExtensionContext): boolean {
		return fermentV2IsBusy(ctx) || fermentV2HasPendingMessages(ctx)
	}

	function fermentV2HasPendingMessages(ctx: ExtensionContext): boolean {
		try {
			return ctx.hasPendingMessages()
		} catch (error) {
			if (isStaleCtxError(error)) return true
			throw error
		}
	}

	function abortEvaluation(): Promise<void> {
		evaluationAbort?.abort()
		return evaluationSettled ?? Promise.resolve()
	}

	function canEvaluateFermentV2(
		expected: PendingFermentV2Continuation,
		fermentV2: SessionFermentV2 | undefined,
		sessionId: string,
		ctx: ExtensionContext,
	): fermentV2 is SessionFermentV2 {
		return (
			fermentV2?.status === "active" &&
			matchesFermentV2(expected, fermentV2, sessionId) &&
			!matchesFermentV2(pendingUserMutation, fermentV2, sessionId) &&
			!fermentV2HasPendingMessages(ctx) &&
			fermentV2ToolsAvailable()
		)
	}

	async function serializeUserMutation<T>(
		sessionId: string,
		captured: SessionFermentV2 | undefined,
		ctx: ExtensionCommandContext,
		source: string,
		operation: () => Promise<T> | T,
	): Promise<T> {
		const current = currentFermentV2
		const marker =
			captured?.status === "active" &&
			current?.id === captured.id &&
			current.revision === captured.revision &&
			fermentV2IsBusy(ctx)
				? { sessionId, fermentV2Id: captured.id, revision: captured.revision }
				: undefined
		if (marker) {
			pendingUserMutation = marker
			const settled = abortEvaluation()
			if (agentTurnIsBusy(ctx)) {
				safeSendControl(
					ctx,
					"The user is changing the active Ferment V2 or its Todo list. Finish the operation already running, then stop before starting more work.",
					{ source, fermentV2Id: marker.fermentV2Id, revision: marker.revision },
				)
				await ctx.waitForIdle()
			}
			await settled
		}
		try {
			return await serializeFermentV2Mutation(sessionId, operation)
		} finally {
			if (pendingUserMutation === marker) pendingUserMutation = undefined
		}
	}

	async function handleTodoCommandMutation<T>(ctx: ExtensionCommandContext, mutation: () => T): Promise<T> {
		const sessionId = bindSession(ctx)
		const captured = currentFermentV2
		return serializeUserMutation(sessionId, captured, ctx, "todo_command", () => {
			assertCurrentSession(ctx, sessionId)
			const result = mutation()
			const current = currentFermentV2
			if (!current) return result
			const todos = getTodosForScope(GLOBAL_TODO_SCOPE, sessionId)
			const previous = matchesFermentV2(todoStateFor, current, sessionId) ? todoStateFor : undefined
			const counts = todoCounts(todos)
			fermentV2Lessons = updateFermentV2Lessons(fermentV2Lessons, todos)
			todoStateFor = {
				sessionId,
				fermentV2Id: current.id,
				revision: current.revision,
				todos,
				...counts,
				settledStatus: deriveSettledStatus(counts, previous?.settledStatus),
			}
			if (current.status === "active") {
				queueFermentV2Turn(
					ctx,
					current,
					buildFermentV2Continuation(
						false,
						"The user changed the Todo list. Reconcile it with the objective before continuing.",
					),
					"todo_command",
					"followUp",
				)
			}
			return result
		})
	}

	function abandonFermentV2Evaluation(sessionId: string, conversation: CapturedFermentV2Conversation): void {
		if (capturedConversation === conversation) capturedConversation = undefined
		// Nothing downstream will drive this Ferment V2 to a terminal state, so a
		// headless command waiting on it would block forever.
		if (!fermentV2ToolsAvailable()) resolveFermentV2Waiter(sessionId, conversation.fermentV2Id)
	}

	function assertUnchanged(captured: SessionFermentV2 | undefined): SessionFermentV2 | undefined {
		const current = currentFermentV2
		if (!captured && !current) return undefined
		if (captured && current?.id === captured.id && current.revision === captured.revision) return current
		throw new StaleFermentV2CommandError(
			"The Ferment V2 changed while this command was open. Retry against the current Ferment V2.",
		)
	}

	async function handleSetFermentV2(
		objective: string,
		tokenBudget: number | undefined,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentFermentV2
		let terminalWaiter: Promise<void> | undefined
		if (!fermentV2ToolsAvailable()) {
			notifyFermentV2ToolsUnavailable(ctx)
			return
		}
		if (captured && captured.status !== "complete") {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"A Ferment V2 is already in progress. Replace it from an interactive session or clear it first.",
					"warning",
				)
				return
			}
			const confirmed = await ctx.ui.confirm(
				"Replace current Ferment V2?",
				`Replace Ferment V2 revision ${captured.revision}? This starts a new Ferment V2.`,
			)
			if (!confirmed) {
				ctx.ui.notify(`Ferment V2 kept: ${captured.objective}`, "info")
				return
			}
		}

		await serializeUserMutation(sessionId, captured, ctx, "command", () => {
			assertCurrentSession(ctx, sessionId)
			assertUnchanged(captured)
			const nowMs = Date.now()
			const now = timestamp(nowMs)
			const effectiveTokenBudget = tokenBudget ?? getFermentV2Settings().defaultTokenBudget
			const next = captured
				? replaceFermentV2(objective, randomUUID(), now, effectiveTokenBudget)
				: createFermentV2(undefined, objective, randomUUID(), now, effectiveTokenBudget)
			commitFermentV2(next)
			emitFermentV2Lifecycle(captured ? FERMENT_V2_EVENTS.REPLACED : FERMENT_V2_EVENTS.STARTED, next)
			resetFermentV2Runtime()
			// Only block a headless command when a turn is actually running, or
			// nothing would ever resolve the waiter.
			if (
				queueFermentV2Turn(ctx, next, buildFermentV2StartSteer(captured ? "replaced" : "created"), "command") &&
				!ctx.hasUI
			) {
				terminalWaiter = ensureFermentV2Waiter(sessionId, next.id)
			}
			ctx.ui.notify(captured ? "Ferment V2 replaced." : "Ferment V2 created.", "info")
		})
		await terminalWaiter
	}

	async function handleEditFermentV2(objective: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentFermentV2
		let terminalWaiter: Promise<void> | undefined
		if (!captured) {
			ctx.ui.notify("No Ferment V2 is currently set.", "warning")
			return
		}

		let editedObjective = objective
		if (editedObjective === undefined) {
			if (!ctx.hasUI) {
				ctx.ui.notify(`Use /${FERMENT_V2_COMMAND_NAME} edit <objective> outside the interactive TUI.`, "warning")
				return
			}
			editedObjective = await ctx.ui.editor("Edit Ferment V2", captured.objective)
			if (editedObjective === undefined) return
		}

		try {
			await serializeUserMutation(sessionId, captured, ctx, "edit", () => {
				assertCurrentSession(ctx, sessionId)
				const current = assertUnchanged(captured)
				if (!current) throw new Error("No Ferment V2 is currently set.")
				const nowMs = Date.now()
				const now = timestamp(nowMs)
				const accounted = checkpointFermentV2(current, 0, nowMs)
				const edited = editFermentV2(accounted, current.id, current.revision, editedObjective, now)
				// Reset both guard counters in the committed revision so a later restart
				// doesn't restore a streak that belonged to a superseded objective.
				const next = setFermentV2UnchangedContinuationTurns(
					setFermentV2ConsecutiveErrorTurns(edited, edited.id, edited.revision, 0, now),
					edited.id,
					edited.revision,
					0,
					now,
				)
				const retainedTodoState =
					todoStateFor && matchesFermentV2(todoStateFor, current, sessionId)
						? rebindTodoState(todoStateFor, next)
						: undefined
				commitFermentV2(next)
				emitFermentV2Lifecycle(FERMENT_V2_EVENTS.EDITED, next)
				activeSinceMs = current.status === "active" && activeSinceMs !== undefined ? nowMs : undefined
				invalidateContinuation()
				todoStateFor = retainedTodoState
				if (
					next.status === "active" &&
					queueFermentV2Turn(ctx, next, buildFermentV2EditSteer(next, current.revision), "edit") &&
					!ctx.hasUI
				) {
					terminalWaiter = ensureFermentV2Waiter(sessionId, next.id)
				}
				ctx.ui.notify(`Ferment V2 updated to revision ${next.revision}.`, "info")
			})
		} catch (error) {
			if (error instanceof StaleFermentV2CommandError) {
				ctx.ui.notify(
					`The Ferment V2 changed while the editor was open. Reopen /${FERMENT_V2_COMMAND_NAME} edit to edit the current revision.`,
					"warning",
				)
				return
			}
			throw error
		}
		await terminalWaiter
	}

	async function handlePauseFermentV2(ctx: ExtensionCommandContext): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentFermentV2
		if (!captured) return ctx.ui.notify("No Ferment V2 is currently set.", "warning")
		await serializeUserMutation(sessionId, captured, ctx, "pause", () => {
			assertCurrentSession(ctx, sessionId)
			const current = assertUnchanged(captured)
			if (!current) throw new Error("No Ferment V2 is currently set.")
			if (current.status === "paused") return ctx.ui.notify("Ferment V2 is already paused.", "info")
			if (current.status === "budget_limited") {
				return ctx.ui.notify(
					"Ferment V2 already stopped at its token budget. Start a replacement Ferment V2 to continue.",
					"warning",
				)
			}
			if (current.status === "complete") return ctx.ui.notify("A completed Ferment V2 cannot be paused.", "warning")
			const nowMs = Date.now()
			const accounted = checkpointFermentV2(current, 0, nowMs)
			const next = setFermentV2Status(accounted, current.id, current.revision, "paused", timestamp(nowMs))
			commitFermentV2(next)
			emitFermentV2Lifecycle(FERMENT_V2_EVENTS.PAUSED, next, { reason: "user" })
			activeSinceMs = undefined
			invalidateContinuation()
			ctx.ui.notify("Ferment V2 paused.", "info")
		})
	}

	async function handleResumeFermentV2(ctx: ExtensionCommandContext): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentFermentV2
		let terminalWaiter: Promise<void> | undefined
		if (!captured) return ctx.ui.notify("No Ferment V2 is currently set.", "warning")
		await serializeUserMutation(sessionId, captured, ctx, "resume", () => {
			assertCurrentSession(ctx, sessionId)
			const current = assertUnchanged(captured)
			if (!current) throw new Error("No Ferment V2 is currently set.")
			if (current.status === "active") return ctx.ui.notify("Ferment V2 is already active.", "info")
			if (current.status === "budget_limited") {
				return ctx.ui.notify(
					"Ferment V2 token budget is exhausted. Start a replacement Ferment V2 with a new budget.",
					"warning",
				)
			}
			if (current.status === "complete") return ctx.ui.notify("A completed Ferment V2 cannot be resumed.", "warning")
			if (!fermentV2ToolsAvailable()) {
				notifyFermentV2ToolsUnavailable(ctx)
				return
			}
			const nowMs = Date.now()
			const now = timestamp(nowMs)
			const activated = setFermentV2Status(current, current.id, current.revision, "active", now)
			if (activated.status !== "active") {
				commitFermentV2(activated)
				ctx.ui.notify(
					"Ferment V2 token budget is exhausted. Start a replacement Ferment V2 with a new budget.",
					"warning",
				)
				return
			}
			// Explicit resume resets both persisted guard counters in this commit; replay preserves them.
			const next = setFermentV2UnchangedContinuationTurns(
				setFermentV2ConsecutiveErrorTurns(activated, activated.id, activated.revision, 0, now),
				activated.id,
				activated.revision,
				0,
				now,
			)
			commitFermentV2(next)
			invalidateContinuation()
			if (queueFermentV2Turn(ctx, next, buildFermentV2StartSteer("resumed"), "resume") && !ctx.hasUI) {
				terminalWaiter = ensureFermentV2Waiter(sessionId, next.id)
			}
			ctx.ui.notify("Ferment V2 resumed.", "info")
		})
		await terminalWaiter
	}

	async function handleClearFermentV2(ctx: ExtensionCommandContext): Promise<void> {
		const sessionId = bindSession(ctx)
		const captured = currentFermentV2
		if (!captured) return ctx.ui.notify("No Ferment V2 is currently set.", "info")
		await serializeUserMutation(sessionId, captured, ctx, "clear", () => {
			assertCurrentSession(ctx, sessionId)
			const current = assertUnchanged(captured)
			if (!current) throw new Error("No Ferment V2 is currently set.")
			commitClear(current)
			invalidateContinuation()
			todoStateFor = undefined
			fermentV2Lessons = []
			activeSinceMs = undefined
			ctx.ui.notify("Ferment V2 cleared.", "info")
		})
	}

	pi.registerTool({
		name: GET_FERMENT_V2_TOOL_NAME,
		label: "Get Ferment V2",
		description:
			"Recover the persistent Kimchi session Ferment V2 only when the canonical Ferment V2 context is missing or inconsistent.",
		promptSnippet: "Recover missing persistent session Ferment V2 context",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			bindSession(ctx)
			const current = currentFermentV2
			const fermentV2 = current ? { ...current, timeUsedMs: current.timeUsedMs + liveElapsedMs() } : null
			return {
				content: [{ type: "text" as const, text: JSON.stringify({ fermentV2 }, null, 2) }],
				details: { fermentV2 },
			}
		},
	})

	pi.registerTool({
		name: UPDATE_FERMENT_V2_TOOL_NAME,
		label: "Update Ferment V2",
		description:
			"Claim the active turn's Ferment V2 is complete, or mark it blocked. A complete claim does not finish Ferment V2: an independent check reads the conversation after the turn settles and decides. Blocked takes effect immediately. Cannot edit, pause, resume, replace, or clear Ferment V2.",
		promptSnippet: "Claim the current Ferment V2 revision is complete, or mark it blocked",
		promptGuidelines: [
			"Claim complete only after current evidence proves every requirement is met. Report blocked only when the objective cannot be completed without user or external action after trying viable alternatives; one unavailable preferred tool or check is not a blockage.",
			"A complete claim is reviewed by a separate check that sees only what this conversation shows. If it disagrees you get its reason and keep working, so surface the evidence in the transcript rather than asserting success.",
			"Repeating an unchanged claim is not progress and will stall Ferment V2. Do new work or gather new evidence before claiming again.",
			"completion_confidence is your reported verification basis for UX and telemetry, not independent proof of correctness.",
			`After the final todo mutation returns its settled result, call ${UPDATE_FERMENT_V2_TOOL_NAME} as the only tool call in a later response.`,
		],
		parameters: UPDATE_FERMENT_V2_PARAMETERS,
		async execute(_toolCallId, params: UpdateFermentV2Params, _signal, _onUpdate, ctx) {
			const sessionId = bindSession(ctx)
			try {
				const fermentV2 = await serializeFermentV2Mutation(sessionId, () => {
					assertCurrentSession(ctx, sessionId)
					if (params.status !== "complete" && params.status !== "blocked") {
						throw new Error(`Ferment V2 update rejected: invalid terminal status '${String(params.status)}'.`)
					}
					const current = currentFermentV2
					if (current?.status !== "active" || !matchesFermentV2(activeTurn, current, sessionId)) {
						throw new Error(
							"Ferment V2 update rejected: the Ferment V2 changed or stopped during this turn. Continue against the current active Ferment V2 before updating it.",
						)
					}
					const completionConfidence = params.status === "complete" ? params.completion_confidence : undefined
					if (params.status === "complete") {
						completionClaim = {
							sessionId,
							fermentV2Id: current.id,
							revision: current.revision,
							...(completionConfidence ? { completionConfidence } : {}),
						}
						// A completion claim is not progress.
						clearPendingContinuation()
						return current
					}

					const nowMs = Date.now()
					const accounted = checkpointFermentV2(current, 0, nowMs)
					const next = setFermentV2Status(
						accounted,
						current.id,
						current.revision,
						"blocked",
						timestamp(nowMs),
						params.reason,
					)
					commitFermentV2(next, false)
					emitFermentV2Lifecycle(FERMENT_V2_EVENTS.BLOCKED, next)
					activeSinceMs = undefined
					invalidateContinuation()
					pendingTerminalFeedback = {
						sessionId,
						fermentV2Id: next.id,
						revision: next.revision,
					}
					return next
				})
				return {
					content: [
						{
							type: "text" as const,
							text:
								params.status === "complete"
									? `Ferment V2 ${fermentV2.id} revision ${fermentV2.revision} completion claimed. Independent evaluation will run after the agent settles.`
									: `Ferment V2 ${fermentV2.id} revision ${fermentV2.revision} marked blocked. Final usage will be shown after this turn is accounted.`,
						},
					],
					details: { fermentV2, reason: params.reason },
					terminate: true,
				}
			} catch (error) {
				const message = errorMessage(error)
				return {
					content: [{ type: "text" as const, text: message }],
					details: { fermentV2: currentFermentV2 ?? null, error: message },
				}
			}
		},
	})

	pi.registerCommand(FERMENT_V2_COMMAND_NAME, {
		description: "Set or manage a persistent session Ferment V2",
		getArgumentCompletions: (prefix) =>
			FERMENT_V2_COMMAND_COMPLETIONS.filter((entry) => entry.startsWith(prefix.toLowerCase())).map((value) => ({
				value: value === "edit" ? "edit " : value,
				label: value,
				description: `/${FERMENT_V2_COMMAND_NAME} ${value}`,
			})),
		handler: async (args, ctx) => {
			try {
				const command = parseFermentV2Command(args)
				if (command.action === "show") {
					bindSession(ctx)
					ctx.ui.notify(formatFermentV2Summary(currentFermentV2, liveElapsedMs()), "info")
					return
				}
				if (command.action === "set") await handleSetFermentV2(command.objective, command.tokenBudget, ctx)
				else if (command.action === "edit") await handleEditFermentV2(command.objective, ctx)
				else if (command.action === "pause") await handlePauseFermentV2(ctx)
				else if (command.action === "resume") await handleResumeFermentV2(ctx)
				else await handleClearFermentV2(ctx)
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "warning")
			}
		},
	})

	pi.on("session_start", (_event, ctx) => {
		replaySession(ctx)
		// Defer a resumed Ferment V2's kick so an embedder's incoming prompt wins the
		// streaming-slot race; the timer rechecks busy, pending, and Ferment V2 identity.
		// No waiter is held open, and pendingContinuation keeps repeated resumes idempotent.
		const fermentV2 = currentFermentV2
		if (fermentV2?.status !== "active") return
		if (!getFermentV2Settings().autoResume) return
		if (!ctx.hasUI) return
		const sessionId = currentSessionId
		const fermentV2Id = fermentV2.id
		const fermentV2Revision = fermentV2.revision
		const resumeKickTimer = setTimeout(() => {
			if (currentSessionId !== sessionId) return
			const latest = currentFermentV2
			if (latest?.id !== fermentV2Id || latest.revision !== fermentV2Revision || latest.status !== "active") return
			if (fermentV2ResumeBlocked(ctx)) return
			queueFermentV2Turn(ctx, latest, buildFermentV2StartSteer("resumed"), "session_start_resume", "followUp")
		}, 0)
		resumeKickTimer.unref()
	})

	pi.on("session_tree", (_event, ctx) => {
		replaySession(ctx)
	})

	pi.on("session_compact", async (event, ctx) => {
		if (event.reason !== "manual") return
		const sessionId = bindSession(ctx)
		await serializeFermentV2Mutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			const current = currentFermentV2
			if (current?.status !== "paused" || !matchesFermentV2(failedTurn, current, sessionId)) return

			failedTurn = undefined
			const resumed = setFermentV2Status(current, current.id, current.revision, "active", timestamp())
			commitFermentV2(resumed)
			if (resumed.status !== "active") {
				invalidateContinuation()
				ctx.ui.notify(
					`Ferment V2 stopped after reaching its ${formatCount(resumed.tokenBudget ?? 0)} token budget.`,
					"warning",
				)
				return
			}
			queueFermentV2TurnAfterSettled(ctx, resumed, buildFermentV2StartSteer("resumed"), "manual_compaction")
		})
	})

	pi.on("context", (event, ctx) => {
		bindSession(ctx)
		const messages = replaceFermentV2ContextMessages(event.messages, currentFermentV2, fermentV2Lessons)
		return messages ? { messages } : undefined
	})

	pi.on("tool_call", (event, ctx) => {
		bindSession(ctx)
		const fermentV2 = currentFermentV2
		if (fermentV2?.status !== "active") return
		if (event.toolName !== UPDATE_FERMENT_V2_TOOL_NAME) return
		if (!matchesFermentV2(activeTurn, fermentV2, currentSessionId)) {
			return {
				block: true,
				reason: `The Ferment V2 changed or stopped during this turn. Continue against the current active Ferment V2 before calling ${UPDATE_FERMENT_V2_TOOL_NAME}.`,
			}
		}
		if (event.input.status === "blocked") return
		const currentTodoState = matchesFermentV2(todoStateFor, fermentV2, currentSessionId) ? todoStateFor : undefined
		if (currentTodoState?.total && event.input.status === currentTodoState.settledStatus) return
		return {
			block: true,
			reason: `Before ending the Ferment V2, keep a visible tactical todo list for this Ferment V2 revision and settle every item as completed or genuinely blocked. Then call ${UPDATE_FERMENT_V2_TOOL_NAME} with the matching status without clearing the list.`,
		}
	})

	pi.on("tool_execution_end", (event, ctx) => {
		bindSession(ctx)
		const fermentV2 = currentFermentV2
		const currentTurn = matchesFermentV2(activeTurn, fermentV2, currentSessionId) ? fermentV2 : undefined
		// Only work done under an active Ferment V2 counts, or tool calls made while the
		// Ferment V2 is paused make the first turn after /ferment-v2 resume look productive.
		if (
			currentTurn?.status === "active" &&
			!event.isError &&
			!TODO_TOOL_NAME_SET.has(event.toolName) &&
			!FERMENT_V2_TOOL_NAME_SET.has(event.toolName)
		) {
			substantiveToolUseSinceEvaluation = true
		}
		if (event.isError || !TODO_TOOL_NAME_SET.has(event.toolName)) return
		const expectedScopeKey = getTodoScopeKey(resolveTodoScope())
		const todoState = todoResultState(event.result, expectedScopeKey)
		if (currentTurn?.status !== "active" || !todoState) return
		const previous = matchesFermentV2(todoStateFor, currentTurn, currentSessionId) ? todoStateFor : undefined
		fermentV2Lessons = updateFermentV2Lessons(fermentV2Lessons, todoState.todos)
		todoStateFor = {
			sessionId: currentSessionId ?? ctx.sessionManager.getSessionId(),
			fermentV2Id: currentTurn.id,
			revision: currentTurn.revision,
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
		const fermentV2 = currentFermentV2
		if (fermentV2?.status === "active") {
			activeSinceMs ??= Date.now()
			activeTurn = {
				sessionId: ctx.sessionManager.getSessionId(),
				fermentV2Id: fermentV2.id,
				revision: fermentV2.revision,
			}
			const todoState = matchesFermentV2(todoStateFor, fermentV2, currentSessionId) ? todoStateFor : undefined
			turnStartFingerprint = fermentV2ProgressFingerprint(fermentV2, todoState, fermentV2Lessons)
		} else {
			activeTurn = undefined
			turnStartFingerprint = undefined
		}
	})

	pi.on("turn_end", async (event, ctx) => {
		const sessionId = bindSession(ctx)
		await serializeFermentV2Mutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			const attribution = activeTurn
			activeTurn = undefined
			const current = currentFermentV2
			const pendingFeedback = pendingTerminalFeedback
			const deferTerminalWaiter = pendingFeedback !== undefined && matchesFermentV2(pendingFeedback, current, sessionId)
			if (
				attribution?.sessionId === sessionId &&
				current?.id === attribution.fermentV2Id &&
				current.revision === attribution.revision
			) {
				const nowMs = Date.now()
				const now = timestamp(nowMs)
				const accounted = checkpointFermentV2(current, assistantTurnTokens(event), nowMs)
				const reachedBudget = current.status === "active" && accounted.status === "budget_limited"
				const interruption = current.status === "active" ? assistantTurnInterruption(event) : undefined
				failedTurn = interruption ? { sessionId, fermentV2Id: current.id, revision: current.revision } : undefined
				// Retry attempts can each emit turn_end before one agent_settled. Keep
				// the existing streak until that run settles; only a completed run can
				// contribute one consecutive error.
				const withErrorTurns = setFermentV2ConsecutiveErrorTurns(
					accounted,
					current.id,
					current.revision,
					interruption === "error" ? (current.consecutiveErrorTurns ?? 0) : 0,
					now,
				)
				// Only an abort pauses at turn_end; an "error" interruption accumulates a
				// streak that `agent_settled` acts on once the run settles.
				const aborted = interruption === "aborted"
				const next = aborted
					? setFermentV2Status(withErrorTurns, current.id, current.revision, "paused", now)
					: withErrorTurns
				if (next !== current) commitFermentV2(next, !deferTerminalWaiter)
				activeSinceMs = undefined
				if (aborted) {
					emitFermentV2Lifecycle(FERMENT_V2_EVENTS.PAUSED, next, { reason: "agent_aborted" })
					invalidateContinuation()
					ctx.ui.notify("Ferment V2 paused because the agent turn was cancelled.", "warning")
				} else if (reachedBudget) {
					invalidateContinuation()
					ctx.ui.notify(
						`Ferment V2 stopped after reaching its ${formatCount(accounted.tokenBudget ?? 0)} token budget.`,
						"warning",
					)
				}
			}

			if (pendingFeedback && matchesFermentV2(pendingFeedback, currentFermentV2, sessionId)) {
				ctx.ui.notify("Ferment V2 blocked.", "warning")
				pendingTerminalFeedback = undefined
				resolveFermentV2Waiter(sessionId, pendingFeedback.fermentV2Id)
			}
		})
	})

	pi.on("agent_end", (_event, ctx) => {
		const sessionId = bindSession(ctx)
		const fermentV2 = currentFermentV2
		const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages
		capturedConversation =
			fermentV2?.status === "active"
				? {
						sessionId,
						fermentV2Id: fermentV2.id,
						revision: fermentV2.revision,
						messages,
						failed: matchesFermentV2(failedTurn, fermentV2, sessionId),
					}
				: undefined
	})

	pi.on("agent_settled", async (_event, ctx) => {
		const sessionId = bindSession(ctx)
		const capturedFermentV2 = currentFermentV2
		const conversation = capturedConversation
		if (!conversation) return
		if (!canEvaluateFermentV2(conversation, capturedFermentV2, sessionId, ctx)) {
			abandonFermentV2Evaluation(sessionId, conversation)
			return
		}
		if (conversation.failed) {
			const now = timestamp()
			const settledErrors = (capturedFermentV2.consecutiveErrorTurns ?? 0) + 1
			const withErrorTurns = setFermentV2ConsecutiveErrorTurns(
				capturedFermentV2,
				capturedFermentV2.id,
				capturedFermentV2.revision,
				settledErrors,
				now,
			)
			const { maxConsecutiveErrors } = getFermentV2Settings()
			capturedConversation = undefined
			if (settledErrors >= maxConsecutiveErrors) {
				const paused = setFermentV2Status(withErrorTurns, withErrorTurns.id, withErrorTurns.revision, "paused", now)
				commitFermentV2(paused)
				emitFermentV2Lifecycle(FERMENT_V2_EVENTS.PAUSED, paused, { reason: "agent_errors" })
				invalidateContinuation()
				ctx.ui.notify(`Ferment V2 paused after ${maxConsecutiveErrors} consecutive agent errors.`, "warning")
				return
			}
			commitFermentV2(withErrorTurns)
			queueFermentV2TurnAfterSettled(ctx, withErrorTurns, buildFermentV2ErrorContinuation(), "agent_error")
			return
		}
		const capturedTodoState = matchesFermentV2(todoStateFor, capturedFermentV2, sessionId) ? todoStateFor : undefined
		const hadSubstantiveToolUse = substantiveToolUseSinceEvaluation
		const startFingerprint = turnStartFingerprint
		evaluationAbort = new AbortController()
		const abort = evaluationAbort
		const evaluation = evaluateFermentV2(
			{
				objective: capturedFermentV2.objective,
				messages: conversation.messages,
				todos: capturedTodoState?.todos ?? [],
				lessons: fermentV2Lessons,
				signal: abort.signal,
			},
			ctx,
		)
		const settled = evaluation.then(
			() => undefined,
			() => undefined,
		)
		evaluationSettled = settled
		let result: FermentV2EvaluationResult
		try {
			result = await evaluation
		} finally {
			if (evaluationAbort === abort) evaluationAbort = undefined
			if (evaluationSettled === settled) evaluationSettled = undefined
		}
		if (currentSessionId !== sessionId || ctx.sessionManager.getSessionId() !== sessionId) return
		await serializeFermentV2Mutation(sessionId, () => {
			assertCurrentSession(ctx, sessionId)
			// Input/tool availability or cancellation can invalidate the verdict.
			if (abort.signal.aborted) return
			const fermentV2 = currentFermentV2
			if (!canEvaluateFermentV2(conversation, fermentV2, sessionId, ctx)) {
				abandonFermentV2Evaluation(sessionId, conversation)
				return
			}
			const now = timestamp()
			const evaluation: FermentV2Evaluation = {
				verdict: result.verdict,
				reason: result.reason,
				...(result.model ? { model: result.model } : {}),
				evaluatedAt: now,
			}
			const evaluated = recordFermentV2Evaluation(fermentV2, fermentV2.id, fermentV2.revision, evaluation, now)
			capturedConversation = undefined
			substantiveToolUseSinceEvaluation = false

			const emitEvaluation = (recorded: SessionFermentV2): void => {
				if (result.verdict === "unavailable" || !result.usage) return
				pi.events.emit(FERMENT_V2_EVENTS.EVALUATED, {
					fermentV2Id: recorded.id,
					verdict: result.verdict,
					count: recorded.evaluationCount ?? 1,
					model: result.model,
					usage: result.usage,
				})
			}

			// Commit before evaluation/lifecycle events; both consume the committed Ferment V2.
			const recordTerminalOutcome = (
				fermentV2: SessionFermentV2,
				event: FermentV2EventName,
				notify: { message: string; level: "info" | "warning" },
				options: {
					details?: Pick<FermentV2LifecyclePayload, "reason" | "continuationCount">
					skipEvaluationEvent?: boolean
					keepCompletionClaim?: boolean
				} = {},
			): void => {
				commitFermentV2(fermentV2)
				if (!options.skipEvaluationEvent) emitEvaluation(fermentV2)
				emitFermentV2Lifecycle(event, fermentV2, options.details)
				if (!options.keepCompletionClaim) completionClaim = undefined
				activeSinceMs = undefined
				invalidateContinuation()
				ctx.ui.notify(notify.message, notify.level)
			}

			if (result.verdict === "unavailable") {
				const paused = setFermentV2Status(evaluated, evaluated.id, evaluated.revision, "paused", now)
				recordTerminalOutcome(
					paused,
					FERMENT_V2_EVENTS.PAUSED,
					{ message: `Ferment V2 paused: ${result.reason}`, level: "warning" },
					{ details: { reason: "evaluator_unavailable" }, skipEvaluationEvent: true },
				)
				return
			}

			if (result.verdict === "impossible") {
				const blocked = setFermentV2Status(evaluated, evaluated.id, evaluated.revision, "blocked", now, result.reason)
				recordTerminalOutcome(blocked, FERMENT_V2_EVENTS.BLOCKED, {
					message: `Ferment V2 blocked: ${result.reason}`,
					level: "warning",
				})
				return
			}

			const todoState = matchesFermentV2(todoStateFor, evaluated, sessionId) ? todoStateFor : undefined
			if (result.verdict === "met" && todoState?.total && todoState.settledStatus === "complete") {
				const claim = matchesFermentV2(completionClaim, evaluated, sessionId) ? completionClaim : undefined
				const completed = {
					...setFermentV2Status(evaluated, evaluated.id, evaluated.revision, "complete", now),
					...(claim?.completionConfidence ? { completionConfidence: claim.completionConfidence } : {}),
				}
				recordTerminalOutcome(completed, FERMENT_V2_EVENTS.COMPLETED, {
					message: "Ferment V2 complete.",
					level: "info",
				})
				return
			}

			// Keep the claim across continue; it remains scoped to this Ferment V2 revision.
			const continuationReason =
				result.verdict === "met"
					? "The evaluator found the objective met, but the current Ferment V2 revision still needs a visible, fully completed Todo list."
					: result.reason
			const fingerprint = fermentV2ProgressFingerprint(evaluated, todoState, fermentV2Lessons)
			const { maxUnchangedContinuations } = getFermentV2Settings()
			const unchanged =
				!hadSubstantiveToolUse && fingerprint === startFingerprint ? (evaluated.unchangedContinuationTurns ?? 0) + 1 : 0
			// Folded into the single commit below (a no-op if unchanged) rather than committed
			// separately after queueFermentV2Turn: that would mean two commits per turn, and by then
			// queueFermentV2Turn's pi.sendMessage(triggerTurn) may already have raced a synchronously-started next turn.
			const withContinuationCount = setFermentV2UnchangedContinuationTurns(
				evaluated,
				evaluated.id,
				evaluated.revision,
				unchanged,
				now,
			)
			if (unchanged >= maxUnchangedContinuations) {
				const paused = setFermentV2Status(
					withContinuationCount,
					withContinuationCount.id,
					withContinuationCount.revision,
					"paused",
					now,
				)
				recordTerminalOutcome(
					paused,
					FERMENT_V2_EVENTS.STALLED,
					{
						message: `Ferment V2 paused after ${maxUnchangedContinuations} unchanged continuation turns without substantive tool use.`,
						level: "warning",
					},
					{
						details: { reason: "no_progress", continuationCount: unchanged },
						keepCompletionClaim: true,
					},
				)
				return
			}

			commitFermentV2(withContinuationCount)
			emitEvaluation(withContinuationCount)
			queueFermentV2TurnAfterSettled(
				ctx,
				withContinuationCount,
				buildFermentV2Continuation(unchanged > 0, continuationReason),
				"evaluation",
			)
		})
	})

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.sessionManager.getSessionId() !== currentSessionId) return
		unregisterTodoCommandMutationHandler?.()
		unregisterTodoCommandMutationHandler = undefined
		void abortEvaluation()
		resolveSessionWaiters(currentSessionId)
		currentSessionId = undefined
		resetFermentV2Runtime()
		currentFermentV2 = undefined
	})
}

function matchesFermentV2(
	marker: PendingFermentV2Continuation | undefined,
	fermentV2: SessionFermentV2 | undefined,
	sessionId: string | undefined,
): fermentV2 is SessionFermentV2 {
	return Boolean(
		marker &&
			fermentV2 &&
			marker.sessionId === sessionId &&
			marker.fermentV2Id === fermentV2.id &&
			marker.revision === fermentV2.revision,
	)
}

function restoreFermentV2Runtime(
	entries: readonly SessionEntry[],
	sessionId: string,
	expectedScopeKey: string,
): { fermentV2: FermentV2State; todoState: FermentV2TodoState | undefined; lessons: FermentV2Lesson[] } {
	let fermentV2: FermentV2State
	let todoState: FermentV2TodoState | undefined
	let lessons: FermentV2Lesson[] = []

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === FERMENT_V2_CUSTOM_ENTRY_TYPE) {
			const previous = fermentV2
			fermentV2 = restoreFermentV2([entry.data], fermentV2)
			if (!sameFermentV2Revision(previous, fermentV2)) {
				if (previous && fermentV2 && previous.id === fermentV2.id) {
					if (todoState) todoState = rebindTodoState(todoState, fermentV2)
				} else {
					todoState = undefined
					lessons = []
				}
			}
		}

		const details = getWriteTodosDetails(entry)
		if (!fermentV2 || !details || getTodoScopeKey(normalizeTodoScope(details.scope)) !== expectedScopeKey) continue
		lessons = updateFermentV2Lessons(lessons, details.todos)
		const counts = todoCounts(details.todos)
		todoState = {
			sessionId,
			fermentV2Id: fermentV2.id,
			revision: fermentV2.revision,
			todos: details.todos,
			...counts,
			settledStatus: deriveSettledStatus(counts, todoState?.settledStatus),
		}
	}

	return { fermentV2, todoState, lessons }
}

function sameFermentV2Revision(left: FermentV2State, right: FermentV2State): boolean {
	return left?.id === right?.id && left?.revision === right?.revision
}

function todoCounts(todos: readonly unknown[]): Pick<FermentV2TodoState, "total" | "blocked" | "completed"> {
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
	counts: Pick<FermentV2TodoState, "total" | "blocked" | "completed">,
	previousSettledStatus: FermentV2TodoState["settledStatus"],
): FermentV2TodoState["settledStatus"] {
	if (counts.total === 0) return previousSettledStatus
	if (counts.completed === counts.total) return "complete"
	if (counts.blocked > 0 && counts.completed + counts.blocked === counts.total) return "blocked"
	return undefined
}

function rebindTodoState(state: FermentV2TodoState, fermentV2: SessionFermentV2): FermentV2TodoState {
	return {
		sessionId: state.sessionId,
		fermentV2Id: fermentV2.id,
		revision: fermentV2.revision,
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
function fermentV2ProgressFingerprint(
	fermentV2: SessionFermentV2,
	todoState: FermentV2TodoState | undefined,
	lessons: readonly FermentV2Lesson[],
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
	return JSON.stringify([fermentV2.id, fermentV2.revision, todos, durableLessons])
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
): Pick<FermentV2TodoState, "todos" | "total" | "blocked" | "completed"> | undefined {
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
