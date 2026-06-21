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
// Map structure: `${fermentId}:${phaseId}` → Map<stepId | "header", todoId>
// The phase header gets a synthetic key "header" to distinguish it from steps.

const todoIdMaps = new Map<string, Map<string, number>>()

function getOrCreateIdMap(fermentId: string, phaseId: string): Map<string, number> {
	const key = `${fermentId}:${phaseId}`
	let map = todoIdMaps.get(key)
	if (!map) {
		map = new Map()
		todoIdMaps.set(key, map)
	}
	return map
}

function clearIdMap(fermentId: string, phaseId: string): void {
	const key = `${fermentId}:${phaseId}`
	todoIdMaps.delete(key)
}

// ─── Suspend / resume snapshot ──────────────────────────────────────────────
// When a ferment is suspended we snapshot every ferment-scoped todo list
// (both `ferment` and `ferment-step` scopes whose phaseId belongs to the
// ferment) and clear them. On resume we restore the snapshot, then drop it.

interface ScopeSnapshot {
	scope: TodoScope
	todos: TodoItem[]
}

const suspendedSnapshots = new Map<string, ScopeSnapshot[]>()

function clearSnapshot(fermentId: string): void {
	suspendedSnapshots.delete(fermentId)
}

/** Find every todo scope (in the current store) whose phaseId matches one of
 *  the given phase IDs and whose kind is ferment-scoped. Global scope is
 *  excluded — it belongs to the user, not the ferment. */
function findFermentScopes(phaseIds: ReadonlySet<string>): ScopeSnapshot[] {
	if (phaseIds.size === 0) return []
	const state = getTodoState()
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

function clearScopeTodos(snapshots: ScopeSnapshot[]): void {
	for (const { scope } of snapshots) {
		applyWriteTodos({ scope, todos: [] })
	}
}

function restoreScopeTodos(snapshots: ScopeSnapshot[]): void {
	for (const { scope, todos } of snapshots) {
		// Re-emit as drafts so the store assigns fresh IDs in the new lifecycle.
		const drafts: TodoDraft[] = todos.map((todo) => ({
			content: todo.content,
			status: todo.status,
			activeForm: todo.activeForm,
			note: todo.note,
		}))
		applyWriteTodos({ scope, todos: drafts })
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

/** Correlation map linking written todo content back to its ferment-internal
 *  key (step ID, or the synthetic "header" key for the phase header row).
 *  Built alongside the TodoDraft list so we can match store-assigned IDs back
 *  to ferment entities deterministically — no reliance on input order. */
type ContentSyncMap = Map<string, string>

function buildPhaseTodos(
	phase: Phase,
	fermentId: string,
): {
	todos: TodoDraft[]
	contentSyncMap: ContentSyncMap
} {
	const idMap = getOrCreateIdMap(fermentId, phase.id)
	const contentSyncMap: ContentSyncMap = new Map()
	const todos: TodoDraft[] = []

	// Phase header — use phase.name as the content, status is always in_progress
	// until the phase is marked complete (handled by PHASE_COMPLETED).
	const headerContent = `[Phase ${phase.index}] ${phase.name}`
	contentSyncMap.set(headerContent, "header")
	todos.push({
		id: idMap.get("header"),
		content: headerContent,
		status: "in_progress",
		activeForm: phase.name,
	})

	// Steps — indented with "↳ " prefix to nest visually under the phase header
	for (const step of phase.steps) {
		const content = `↳ ${step.description}`
		contentSyncMap.set(content, step.id)
		todos.push({
			id: idMap.get(step.id),
			content,
			status: stepStatusToTodoStatus(step.status),
		})
	}

	return { todos, contentSyncMap }
}

function syncTodoIds(
	fermentId: string,
	phaseId: string,
	writtenTodos: TodoItem[],
	contentSyncMap: ContentSyncMap,
): void {
	const idMap = getOrCreateIdMap(fermentId, phaseId)
	// Match written todos back to ferment entities by content. Content is
	// deterministic per phase (the header is `[Phase N] name`, each step is
	// `↳ description`), so this stays correct regardless of how the store
	// reorders, filters, or reassigns IDs internally.
	for (const todo of writtenTodos) {
		const syncKey = contentSyncMap.get(todo.content)
		if (syncKey !== undefined) {
			idMap.set(syncKey, todo.id)
		}
	}
}

// ─── Event handlers ──────────────────────────────────────────────────────────

function handlePhaseStarted(raw: unknown): void {
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

	const { todos, contentSyncMap } = buildPhaseTodos(phase, ferment.id)
	const details = applyWriteTodos({ scope: { kind: "ferment", phaseId: payload.phaseId }, todos })

	// Capture the assigned IDs for future updates
	syncTodoIds(ferment.id, payload.phaseId, details.todos, contentSyncMap)
}

// ─── Active step tracking for scope provider ────────────────────────────────
// When a ferment step is running, scope-less todo calls (update_todos, add_todo)
// automatically target the ferment-step scope instead of global.

let currentRunningStep: { phaseId: string; stepId: string } | undefined

/**
 * Number of orchestrator turns since the step-scope todos were last written.
 * Incremented by `bumpStallCounter()` (called from the turn_end handler in
 * prompt-enrichment), reset to 0 whenever `applyWriteTodos` fires for the
 * active ferment-step scope (via the store listener wired in
 * `registerFermentTodoSync`).
 */
let turnsSinceStepTodoWrite = 0

/** Call once per orchestrator turn_end to track how long the step scope
 *  has been untouched. Only increments when a step is actually running. */
export function bumpStallCounter(): void {
	if (currentRunningStep) turnsSinceStepTodoWrite++
}

/** Returns the number of turns since the step-scope todos were last written,
 *  or 0 when no step is running. */
export function getTurnsSinceStepTodoWrite(): number {
	if (!currentRunningStep) return 0
	return turnsSinceStepTodoWrite
}

/** Exported for tests only. */
export function __getCurrentRunningStep(): { phaseId: string; stepId: string } | undefined {
	return currentRunningStep
}

function handleStepStarted(raw: unknown): void {
	const payload = raw as FermentStepStartedPayload
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	// Track the running step so the scope provider can auto-scope todo calls.
	currentRunningStep = { phaseId: payload.phaseId, stepId: payload.stepId }
	turnsSinceStepTodoWrite = 0
}

function clearStepTodos(phaseId: string, stepId: string): void {
	applyWriteTodos({
		scope: { kind: "ferment-step", phaseId, stepId },
		todos: [],
	})
}

function handleStepCompleted(raw: unknown): void {
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

	// Clear the step-level implementation todos and stop tracking.
	clearStepTodos(payload.phaseId, payload.stepId)
	currentRunningStep = undefined

	const idMap = getOrCreateIdMap(ferment.id, payload.phaseId)
	const stepTodoId = idMap.get(payload.stepId)
	if (stepTodoId === undefined) {
		console.warn(`[todo-sync] STEP_COMPLETED for step ${payload.stepId} but no todo ID recorded. Skipping update.`)
		return
	}

	const currentTodos = getTodosForScope({ kind: "ferment", phaseId: payload.phaseId })
	const updated = currentTodos.map((todo) => {
		if (todo.id === stepTodoId) {
			return { ...todo, status: "completed" as TodoStatus }
		}
		return todo
	})

	applyWriteTodos({ scope: { kind: "ferment", phaseId: payload.phaseId }, todos: updated })
}

function handleStepFailed(raw: unknown): void {
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

	// Clear the step-level implementation todos and stop tracking.
	clearStepTodos(payload.phaseId, payload.stepId)
	currentRunningStep = undefined

	const idMap = getOrCreateIdMap(ferment.id, payload.phaseId)
	const stepTodoId = idMap.get(payload.stepId)
	if (stepTodoId === undefined) {
		console.warn(`[todo-sync] STEP_FAILED for step ${payload.stepId} but no todo ID recorded. Skipping update.`)
		return
	}

	const currentTodos = getTodosForScope({ kind: "ferment", phaseId: payload.phaseId })
	const updated = currentTodos.map((todo) => {
		if (todo.id === stepTodoId) {
			return { ...todo, status: "blocked" as TodoStatus }
		}
		return todo
	})

	applyWriteTodos({ scope: { kind: "ferment", phaseId: payload.phaseId }, todos: updated })
}

function handlePhaseCompleted(raw: unknown): void {
	const payload = raw as FermentPhaseCompletedPayload

	// Guard: ignore stale PHASE_COMPLETED events from ferments other than the
	// currently active one. Without this guard, a late event could mutate the
	// new ferment's todos (if phaseId collides) and drop its sync state.
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	const currentTodos = getTodosForScope({ kind: "ferment", phaseId: payload.phaseId })
	if (currentTodos.length === 0) {
		// No todos written for this phase (edge case: phase with zero steps that
		// completed before PHASE_STARTED fired). Nothing to update.
		clearIdMap(payload.fermentId, payload.phaseId)
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

	applyWriteTodos({ scope: { kind: "ferment", phaseId: payload.phaseId }, todos: updated })

	// Cleanup: drop the ID map for this phase since the phase is now complete
	clearIdMap(payload.fermentId, payload.phaseId)
}

function handleFermentSuspended(raw: unknown): void {
	const payload = raw as FermentSuspendedPayload

	// Active-ferment guard: stale or cross-ferment pause events must not touch
	// the current ferment's todo state.
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	const phaseIds = new Set(ferment.phases.map((p) => p.id))
	const snapshots = findFermentScopes(phaseIds)
	if (snapshots.length === 0) {
		// Nothing to snapshot — make sure no stale snapshot from a prior cycle
		// leaks into a future resume.
		clearSnapshot(ferment.id)
		return
	}

	suspendedSnapshots.set(ferment.id, snapshots)
	clearScopeTodos(snapshots)
}

function handleFermentResumed(raw: unknown): void {
	const payload = raw as FermentResumedPayload

	// Active-ferment guard: stale resume events for a different ferment must
	// not restore snapshot state into the current ferment's scopes.
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	const snapshots = suspendedSnapshots.get(ferment.id)
	if (!snapshots) return // RESUMED without prior SUSPENDED — no-op
	suspendedSnapshots.delete(ferment.id)

	// Only restore scopes that still belong to this ferment. If phases were
	// added/removed between suspend and resume, stale scopes are skipped.
	const phaseIds = new Set(ferment.phases.map((p) => p.id))
	const liveSnapshots = snapshots.filter((snapshot) => {
		const scopePhaseId = (snapshot.scope as { phaseId?: string }).phaseId
		return scopePhaseId !== undefined && phaseIds.has(scopePhaseId)
	})
	restoreScopeTodos(liveSnapshots)
}

function handleFermentCompleted(raw: unknown): void {
	const payload = raw as FermentCompletedPayload

	// Active-ferment guard.
	const ferment = getActive()
	if (!ferment || ferment.id !== payload.fermentId) return

	const phaseIds = new Set(ferment.phases.map((p) => p.id))
	const snapshots = findFermentScopes(phaseIds)
	if (snapshots.length > 0) {
		clearScopeTodos(snapshots)
	}
	// Drop any snapshot left behind by a prior SUSPENDED that was never
	// resumed (e.g. ferment was abandoned mid-suspend). Nothing to restore.
	clearSnapshot(ferment.id)
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register ferment → todo sync listeners on the given ExtensionAPI.
 *
 * Returns an unsubscribe function that removes all listeners and cleans up state.
 */
export function registerFermentTodoSync(pi: ExtensionAPI): () => void {
	const unsubscribes: Array<() => void> = []

	// Auto-scope: when a ferment step is running, scope-less todo calls
	// (update_todos, add_todo without explicit scope) target the active
	// step's ferment-step scope instead of global.
	const unregisterScope = registerActiveTodoScopeProvider(() => {
		if (!currentRunningStep) return undefined
		return {
			kind: "ferment-step" as const,
			phaseId: currentRunningStep.phaseId,
			stepId: currentRunningStep.stepId,
		}
	})

	// Reset the stall counter whenever the active step's todo scope is written to.
	const unsubscribeTodoListener = subscribeTodoStore((details) => {
		if (!currentRunningStep) return
		if (
			details.scope.kind === "ferment-step" &&
			(details.scope as { phaseId: string; stepId: string }).phaseId === currentRunningStep.phaseId &&
			(details.scope as { phaseId: string; stepId: string }).stepId === currentRunningStep.stepId
		) {
			turnsSinceStepTodoWrite = 0
		}
	})

	unsubscribes.push(pi.events.on(FERMENT_EVENTS.PHASE_STARTED, handlePhaseStarted))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.STEP_STARTED, handleStepStarted))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.STEP_COMPLETED, handleStepCompleted))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.STEP_FAILED, handleStepFailed))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.PHASE_COMPLETED, handlePhaseCompleted))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.SUSPENDED, handleFermentSuspended))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.RESUMED, handleFermentResumed))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.COMPLETED, handleFermentCompleted))

	return () => {
		for (const unsub of unsubscribes) {
			unsub()
		}
		unregisterScope()
		unsubscribeTodoListener()
		currentRunningStep = undefined
		turnsSinceStepTodoWrite = 0
		// Clear all in-memory state on unsubscribe to avoid memory leaks.
		todoIdMaps.clear()
		suspendedSnapshots.clear()
	}
}
