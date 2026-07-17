/**
 * Ferment → Todo Sync Bridge
 *
 * Subscribes to ferment lifecycle events and maintains a synchronized todo list
 * for each active phase. The todo list shows:
 *   - A phase header (derived from the phase name)
 *   - One todo per step (indented, reflecting step status)
 *
 * IDs are stable across updates so UI animations and reconciliation work correctly.
 *
 * Lifecycle:
 *   - PHASE_STARTED → populate initial todo list for the phase
 *   - STEP_COMPLETED / STEP_FAILED → update the corresponding step todo
 *   - PHASE_COMPLETED → mark any remaining todos as completed, cleanup
 *   - FERMENT_SUSPENDED → snapshot all ferment-scoped todos, then clear them
 *   - FERMENT_RESUMED → restore the snapshot taken at suspension time
 *   - FERMENT_COMPLETED → clear all ferment-scoped todos (no restore)
 *
 * Every todo-store call is scoped to the session id passed to
 * `registerFermentTodoSync` so that concurrent sessions sharing the same
 * process do not see each other's ferment todos. The bridge's internal
 * state (id maps, suspended snapshots, running steps, stall counter) is
 * also keyed by session id, so each session owns its own bucket and
 * unsubscribe only tears down that session's state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Phase, StepStatus } from "../../ferment/types.js"
import { parseTodoScopeKey } from "../todos/scope.js"
import {
	applyWriteTodos,
	getTodoState,
	getTodosForScope,
	registerActiveTodoScopeProvider,
	subscribeTodoStore,
} from "../todos/store.js"
import type { TodoDraft, TodoItem, TodoScope, TodoStatus } from "../todos/types.js"
import {
	FERMENT_EVENTS,
	type FermentCompletedPayload,
	type FermentPhaseCompletedPayload,
	type FermentPhaseStartedPayload,
	type FermentResumedPayload,
	type FermentStepCompletedPayload,
	type FermentStepFailedPayload,
	type FermentStepStartedPayload,
	type FermentSuspendedPayload,
} from "./domain-events.js"
import { getActive } from "./state.js"

// ─── Stable ID tracking ──────────────────────────────────────────────────────
// All four top-level Maps are keyed by session id so concurrent sessions
// never see each other's bridge state. The second-level key keeps each
// phase / ferment / running-step bucket independent.
//
//   todoIdMaps: sessionId → (fermentId:phaseId → stepKey → todoId)
//   suspendedSnapshots: sessionId → fermentId → ScopeSnapshot[]
//   runningSteps: sessionId → phaseId/stepId → RunningStep
//   turnsSinceStepTodoWrite: sessionId → count

const todoIdMaps = new Map<string, Map<string, Map<string, number>>>()

function getOrCreateIdMap(fermentId: string, phaseId: string, sessionId: string): Map<string, number> {
	let sessionBuckets = todoIdMaps.get(sessionId)
	if (!sessionBuckets) {
		sessionBuckets = new Map()
		todoIdMaps.set(sessionId, sessionBuckets)
	}
	const key = `${fermentId}:${phaseId}`
	let map = sessionBuckets.get(key)
	if (!map) {
		map = new Map()
		sessionBuckets.set(key, map)
	}
	return map
}

function clearIdMap(fermentId: string, phaseId: string, sessionId: string): void {
	const key = `${fermentId}:${phaseId}`
	todoIdMaps.get(sessionId)?.delete(key)
}

// ─── Suspend / resume snapshot ──────────────────────────────────────────────
// When a ferment is suspended we snapshot every ferment-scoped todo list
// (both `ferment` and `ferment-step` scopes whose phaseId belongs to the
// ferment) and clear them. On resume we restore the snapshot, then drop it.

interface ScopeSnapshot {
	scope: TodoScope
	todos: TodoItem[]
}

const suspendedSnapshots = new Map<string, Map<string, ScopeSnapshot[]>>()

function clearSnapshot(sessionId: string, fermentId: string): void {
	suspendedSnapshots.get(sessionId)?.delete(fermentId)
}

/** Find every todo scope (in the current store) whose phaseId matches one of
 *  the given phase IDs and whose kind is ferment-scoped. Global scope is
 *  excluded — it belongs to the user, not the ferment. */
function findFermentScopes(phaseIds: ReadonlySet<string>, sessionId: string): ScopeSnapshot[] {
	if (phaseIds.size === 0) return []
	const state = getTodoState(sessionId)
	const found: ScopeSnapshot[] = []
	for (const scopeKey of Object.keys(state.byScope)) {
		let scope: TodoScope
		try {
			scope = parseTodoScopeKey(scopeKey)
		} catch {
			continue
		}
		if (scope.kind !== "ferment" && scope.kind !== "ferment-step") continue
		const scopePhaseId = (scope as { phaseId?: string }).phaseId
		if (!scopePhaseId || !phaseIds.has(scopePhaseId)) continue
		const scopeState = state.byScope[scopeKey]
		if (!scopeState) continue
		found.push({ scope, todos: [...scopeState.todos] })
	}
	return found
}

function clearScopeTodos(snapshots: ScopeSnapshot[], sessionId: string): void {
	for (const { scope } of snapshots) {
		applyWriteTodos({ scope, todos: [] }, sessionId)
	}
}

function restoreScopeTodos(snapshots: ScopeSnapshot[], sessionId: string): void {
	for (const { scope, todos } of snapshots) {
		// Re-emit as drafts so the store assigns fresh IDs in the new lifecycle.
		const drafts: TodoDraft[] = todos.map((todo) => ({
			content: todo.content,
			status: todo.status,
			activeForm: todo.activeForm,
			note: todo.note,
		}))
		applyWriteTodos({ scope, todos: drafts }, sessionId)
	}
}

// ─── Status mapping ──────────────────────────────────────────────────────────

function stepStatusToTodoStatus(stepStatus: StepStatus): TodoStatus {
	switch (stepStatus) {
		case "pending":
			return "pending"
		case "running":
			return "in_progress"
		case "done":
		case "verified":
		case "skipped":
			return "completed"
		case "failed":
			return "blocked"
		default:
			return "pending"
	}
}

// ─── Todo list builders ──────────────────────────────────────────────────────

/**
 * Build the initial todo list for a phase, tagging each draft with an internal
 * `_syncKey` so `syncTodoIds` can map written items back to the originating
 * ferment entity (phase header or specific step) without depending on the
 * store's internal ordering or user-generated content.
 */
function buildPhaseTodos(
	phase: Phase,
	fermentId: string,
	sessionId: string,
): {
	todos: TodoDraft[]
} {
	const idMap = getOrCreateIdMap(fermentId, phase.id, sessionId)
	const todos: TodoDraft[] = []

	// Phase header — use phase.name as the content, status is always in_progress
	// until the phase is marked complete (handled by PHASE_COMPLETED).
	const headerContent = `[Phase ${phase.index}] ${phase.name}`
	todos.push({
		id: idMap.get("header"),
		content: headerContent,
		status: "in_progress",
		activeForm: phase.name,
		_syncKey: "header",
	})

	// Steps — indented with "↳ " prefix to nest visually under the phase header
	for (const step of phase.steps) {
		const content = `↳ ${step.description}`
		todos.push({
			id: idMap.get(step.id),
			content,
			status: stepStatusToTodoStatus(step.status),
			_syncKey: step.id,
		})
	}

	return { todos }
}

function syncTodoIds(fermentId: string, phaseId: string, sessionId: string, writtenTodos: TodoItem[]): void {
	const idMap = getOrCreateIdMap(fermentId, phaseId, sessionId)
	// Match written todos back to ferment entities via the internal _syncKey.
	// This is deterministic regardless of how the store reorders, filters,
	// or reassigns IDs, and avoids the fragility of correlating on user-
	// generated content (where two steps can share the same description).
	for (const todo of writtenTodos) {
		const key = todo._syncKey
		if (key !== undefined) {
			idMap.set(key, todo.id)
		}
	}
}

// ─── Event handlers ──────────────────────────────────────────────────────────

function handlePhaseStarted(raw: unknown, sessionId: string): void {
	const payload = raw as FermentPhaseStartedPayload
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) {
		// Phase started in a different ferment than the currently active one
		// (unlikely but possible if the runtime state is out of sync). Skip.
		return
	}

	const phase = ferment.phases.find((p) => p.id === payload.phaseId)
	if (!phase) {
		console.warn(
			`[todo-sync] PHASE_STARTED for unknown phase ${payload.phaseId} in ferment ${payload.fermentId}. Skipping.`,
		)
		return
	}

	const { todos } = buildPhaseTodos(phase, ferment.id, sessionId)
	const details = applyWriteTodos({ scope: { kind: "ferment", phaseId: payload.phaseId }, todos }, sessionId)

	// Capture the assigned IDs for future updates
	syncTodoIds(ferment.id, payload.phaseId, sessionId, details.todos)
}

// ─── Active step tracking for scope provider ────────────────────────────────
// When a ferment step is running, scope-less todo calls (update_todos, add_todo)
// automatically target the ferment-step scope instead of global.
//
// We track steps in a Map keyed by `phaseId/stepId` so parallel siblings don't
// overwrite each other's state. When multiple steps are active simultaneously,
// the scope provider returns undefined to force explicit scope on todo calls
// (avoids the ambiguity of writing to whichever step finished last).

type RunningStep = { phaseId: string; stepId: string }

const runningSteps = new Map<string, Map<string, RunningStep>>()

function stepKey(phaseId: string, stepId: string): string {
	return `${phaseId}/${stepId}`
}

function getRunningStepsBucket(sessionId: string): Map<string, RunningStep> {
	let bucket = runningSteps.get(sessionId)
	if (!bucket) {
		bucket = new Map()
		runningSteps.set(sessionId, bucket)
	}
	return bucket
}

/** Exported for tests only. Returns the running-step bucket for a specific
 *  session id so tests can assert without leaking across other sessions. */
export function __getRunningSteps(sessionId: string): ReadonlyMap<string, RunningStep> {
	return runningSteps.get(sessionId) ?? new Map<string, RunningStep>()
}

/**
 * Number of orchestrator turns since any step-scope todos were last written.
 * Per-session so concurrent sessions do not share a counter. Increments only
 * while at least one step is running for the session; resets when any active
 * step's scope is written to.
 */
const turnsSinceStepTodoWrite = new Map<string, number>()

/** Call once per orchestrator turn_end to track how long the step scope
 *  has been untouched. Only increments when a step is actually running
 *  for the given session. */
export function bumpStallCounter(sessionId: string): void {
	const bucket = runningSteps.get(sessionId)
	if (!bucket?.size) return
	turnsSinceStepTodoWrite.set(sessionId, (turnsSinceStepTodoWrite.get(sessionId) ?? 0) + 1)
}

/** Returns the number of turns since any step-scope todos were last written,
 *  or 0 when no step is running for the given session. */
export function getTurnsSinceStepTodoWrite(sessionId: string): number {
	const bucket = runningSteps.get(sessionId)
	if (!bucket?.size) return 0
	return turnsSinceStepTodoWrite.get(sessionId) ?? 0
}

function handleStepStarted(raw: unknown, sessionId: string): void {
	const payload = raw as FermentStepStartedPayload
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	// Track the running step so the scope provider can auto-scope todo calls.
	// Multiple parallel siblings coexist in the map; the scope provider handles
	// the ambiguity when more than one is active.
	getRunningStepsBucket(sessionId).set(stepKey(payload.phaseId, payload.stepId), {
		phaseId: payload.phaseId,
		stepId: payload.stepId,
	})
	turnsSinceStepTodoWrite.set(sessionId, 0)
}

function clearStepTodos(phaseId: string, stepId: string, sessionId: string): void {
	applyWriteTodos({ scope: { kind: "ferment-step", phaseId, stepId }, todos: [] }, sessionId)
}

function handleStepCompleted(raw: unknown, sessionId: string): void {
	const payload = raw as FermentStepCompletedPayload
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	const phase = ferment.phases.find((p) => p.id === payload.phaseId)
	if (!phase) {
		console.warn(
			`[todo-sync] STEP_COMPLETED for unknown phase ${payload.phaseId} in ferment ${payload.fermentId}. Skipping.`,
		)
		return
	}

	const step = phase.steps.find((s) => s.id === payload.stepId)
	if (!step) {
		console.warn(`[todo-sync] STEP_COMPLETED for unknown step ${payload.stepId} in phase ${payload.phaseId}. Skipping.`)
		return
	}

	// Clear the step-level implementation todos and stop tracking this step
	// (parallel siblings remain tracked in runningSteps).
	clearStepTodos(payload.phaseId, payload.stepId, sessionId)
	const bucket = runningSteps.get(sessionId)
	bucket?.delete(stepKey(payload.phaseId, payload.stepId))

	const idMap = getOrCreateIdMap(ferment.id, payload.phaseId, sessionId)
	const stepTodoId = idMap.get(payload.stepId)
	if (stepTodoId === undefined) {
		console.warn(`[todo-sync] STEP_COMPLETED for step ${payload.stepId} but no todo ID recorded. Skipping update.`)
		return
	}

	const currentTodos = getTodosForScope({ kind: "ferment", phaseId: payload.phaseId }, sessionId)
	const updated = currentTodos.map((todo) => {
		if (todo.id === stepTodoId) {
			return { ...todo, status: "completed" as TodoStatus }
		}
		return todo
	})

	applyWriteTodos({ scope: { kind: "ferment", phaseId: payload.phaseId }, todos: updated }, sessionId)
}

function handleStepFailed(raw: unknown, sessionId: string): void {
	const payload = raw as FermentStepFailedPayload
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	const phase = ferment.phases.find((p) => p.id === payload.phaseId)
	if (!phase) {
		console.warn(
			`[todo-sync] STEP_FAILED for unknown phase ${payload.phaseId} in ferment ${payload.fermentId}. Skipping.`,
		)
		return
	}

	const step = phase.steps.find((s) => s.id === payload.stepId)
	if (!step) {
		console.warn(`[todo-sync] STEP_FAILED for unknown step ${payload.stepId} in phase ${payload.phaseId}. Skipping.`)
		return
	}

	// Clear the step-level implementation todos and stop tracking this step
	// (parallel siblings remain tracked in runningSteps).
	clearStepTodos(payload.phaseId, payload.stepId, sessionId)
	runningSteps.get(sessionId)?.delete(stepKey(payload.phaseId, payload.stepId))

	const idMap = getOrCreateIdMap(ferment.id, payload.phaseId, sessionId)
	const stepTodoId = idMap.get(payload.stepId)
	if (stepTodoId === undefined) {
		console.warn(`[todo-sync] STEP_FAILED for step ${payload.stepId} but no todo ID recorded. Skipping update.`)
		return
	}

	const currentTodos = getTodosForScope({ kind: "ferment", phaseId: payload.phaseId }, sessionId)
	const updated = currentTodos.map((todo) => {
		if (todo.id === stepTodoId) {
			return { ...todo, status: "blocked" as TodoStatus }
		}
		return todo
	})

	applyWriteTodos({ scope: { kind: "ferment", phaseId: payload.phaseId }, todos: updated }, sessionId)
}

function handlePhaseCompleted(raw: unknown, sessionId: string): void {
	const payload = raw as FermentPhaseCompletedPayload

	// Guard: ignore stale PHASE_COMPLETED events from ferments other than the
	// currently active one. Without this guard, a late event could mutate the
	// new ferment's todos (if phaseId collides) and drop its sync state.
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	const currentTodos = getTodosForScope({ kind: "ferment", phaseId: payload.phaseId }, sessionId)
	if (currentTodos.length === 0) {
		// No todos written for this phase (edge case: phase with zero steps that
		// completed before PHASE_STARTED fired). Nothing to update.
		clearIdMap(payload.fermentId, payload.phaseId, sessionId)
		return
	}

	// Mark all non-completed, non-blocked todos as completed. This handles steps
	// that were skipped or otherwise didn't receive an explicit STEP_COMPLETED event.
	const updated = currentTodos.map((todo) => {
		if (todo.status !== "completed" && todo.status !== "blocked") {
			return { ...todo, status: "completed" as TodoStatus }
		}
		return todo
	})

	applyWriteTodos({ scope: { kind: "ferment", phaseId: payload.phaseId }, todos: updated }, sessionId)

	// Cleanup: drop the ID map for this phase since the phase is now complete
	clearIdMap(payload.fermentId, payload.phaseId, sessionId)
}

function handleFermentSuspended(raw: unknown, sessionId: string): void {
	const payload = raw as FermentSuspendedPayload

	// Active-ferment guard: stale or cross-ferment pause events must not touch
	// the current ferment's todo state.
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	const phaseIds = new Set(ferment.phases.map((p) => p.id))
	const snapshots = findFermentScopes(phaseIds, sessionId)
	if (snapshots.length === 0) {
		// Nothing to snapshot — make sure no stale snapshot from a prior cycle
		// leaks into a future resume.
		clearSnapshot(sessionId, ferment.id)
		return
	}

	let sessionBuckets = suspendedSnapshots.get(sessionId)
	if (!sessionBuckets) {
		sessionBuckets = new Map()
		suspendedSnapshots.set(sessionId, sessionBuckets)
	}
	sessionBuckets.set(ferment.id, snapshots)
	clearScopeTodos(snapshots, sessionId)
}

function handleFermentResumed(raw: unknown, sessionId: string): void {
	const payload = raw as FermentResumedPayload

	// Active-ferment guard: stale resume events for a different ferment must
	// not restore snapshot state into the current ferment's scopes.
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	const sessionBuckets = suspendedSnapshots.get(sessionId)
	const snapshots = sessionBuckets?.get(ferment.id)
	if (!snapshots) return // RESUMED without prior SUSPENDED — no-op
	sessionBuckets?.delete(ferment.id)

	// Only restore scopes that still belong to this ferment. If phases were
	// added/removed between suspend and resume, stale scopes are skipped.
	const phaseIds = new Set(ferment.phases.map((p) => p.id))
	const liveSnapshots = snapshots.filter((snapshot) => {
		const scopePhaseId = (snapshot.scope as { phaseId?: string }).phaseId
		return scopePhaseId !== undefined && phaseIds.has(scopePhaseId)
	})
	restoreScopeTodos(liveSnapshots, sessionId)
}

function handleFermentCompleted(raw: unknown, sessionId: string): void {
	const payload = raw as FermentCompletedPayload

	// Active-ferment guard.
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	const phaseIds = new Set(ferment.phases.map((p) => p.id))
	const snapshots = findFermentScopes(phaseIds, sessionId)
	if (snapshots.length > 0) {
		clearScopeTodos(snapshots, sessionId)
	}
	// Drop any snapshot left behind by a prior SUSPENDED that was never
	// resumed (e.g. ferment was abandoned mid-suspend). Nothing to restore.
	clearSnapshot(sessionId, ferment.id)
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register ferment → todo sync listeners on the given ExtensionAPI for a
 * specific session id. Every store call inside the bridge targets that
 * session's bucket; concurrent sessions do not see each other's ferment todos.
 *
 * Returns an unsubscribe function that removes all listeners and cleans up
 * only this session's bridge state (id maps, suspended snapshots, running
 * steps, and stall counter for that session id).
 */
export function registerFermentTodoSync(pi: ExtensionAPI, sessionId: string): () => void {
	const unsubscribes: Array<() => void> = []

	// Auto-scope: when exactly one ferment step is running, scope-less todo
	// calls target that step's ferment-step scope. When multiple parallel
	// steps are active, return undefined to force the caller to pass an
	// explicit scope — avoids silently writing to the wrong step.
	const unregisterScope = registerActiveTodoScopeProvider((requestedSessionId) => {
		if (requestedSessionId !== sessionId) return undefined
		const bucket = runningSteps.get(sessionId)
		if (bucket?.size !== 1) return undefined
		const [, step] = [...bucket.entries()][0]
		return {
			kind: "ferment-step" as const,
			phaseId: step.phaseId,
			stepId: step.stepId,
		}
	})

	// Reset the stall counter whenever ANY running step's todo scope is written
	// to within this bridge's session.
	const unsubscribeTodoListener = subscribeTodoStore((details, emitterSessionId) => {
		if (emitterSessionId !== sessionId) return
		const bucket = runningSteps.get(sessionId)
		if (!bucket?.size) return
		if (details.scope.kind !== "ferment-step") return
		const scope = details.scope as { phaseId: string; stepId: string }
		if (bucket.has(stepKey(scope.phaseId, scope.stepId))) {
			turnsSinceStepTodoWrite.set(sessionId, 0)
		}
	})

	unsubscribes.push(pi.events.on(FERMENT_EVENTS.PHASE_STARTED, (raw) => handlePhaseStarted(raw, sessionId)))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.STEP_STARTED, (raw) => handleStepStarted(raw, sessionId)))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.STEP_COMPLETED, (raw) => handleStepCompleted(raw, sessionId)))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.STEP_FAILED, (raw) => handleStepFailed(raw, sessionId)))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.PHASE_COMPLETED, (raw) => handlePhaseCompleted(raw, sessionId)))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.SUSPENDED, (raw) => handleFermentSuspended(raw, sessionId)))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.RESUMED, (raw) => handleFermentResumed(raw, sessionId)))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.COMPLETED, (raw) => handleFermentCompleted(raw, sessionId)))

	return () => {
		for (const unsub of unsubscribes) {
			unsub()
		}
		unregisterScope()
		unsubscribeTodoListener()

		// Tear down only this session's bridge state. Other sessions sharing
		// the process keep their buckets intact.
		runningSteps.delete(sessionId)
		turnsSinceStepTodoWrite.delete(sessionId)

		todoIdMaps.get(sessionId)?.clear()
		todoIdMaps.delete(sessionId)

		suspendedSnapshots.get(sessionId)?.clear()
		suspendedSnapshots.delete(sessionId)
	}
}
