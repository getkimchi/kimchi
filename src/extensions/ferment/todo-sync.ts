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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import type { Phase, Step, StepStatus } from "../../ferment/types.js"
import { applyWriteTodos, getTodosForScope } from "../todos/store.js"
import type { TodoDraft, TodoItem, TodoStatus } from "../todos/types.js"
import {
	FERMENT_EVENTS,
	type FermentPhaseCompletedPayload,
	type FermentPhaseStartedPayload,
	type FermentStepCompletedPayload,
	type FermentStepFailedPayload,
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

function buildPhaseTodos(phase: Phase, fermentId: string): TodoDraft[] {
	const idMap = getOrCreateIdMap(fermentId, phase.id)
	const todos: TodoDraft[] = []

	// Phase header — use phase.name as the content, status is always in_progress
	// until the phase is marked complete (handled by PHASE_COMPLETED).
	const headerContent = `[Phase ${phase.index}] ${phase.name}`
	const headerId = idMap.get("header")
	todos.push({
		id: headerId,
		content: headerContent,
		status: "in_progress",
		activeForm: phase.name,
	})
	if (headerId === undefined) {
		// First write — auto-assign ID 1 for header. TodoStore will assign it
		// and we'll capture it on the next read cycle. For now, leave undefined.
		// We rely on the fact that the store assigns IDs sequentially starting
		// from nextId, so the header gets the first ID and steps get subsequent IDs.
	}

	// Steps — indented with "↳ " prefix to nest visually under the phase header
	for (const step of phase.steps) {
		const stepId = idMap.get(step.id)
		const status = stepStatusToTodoStatus(step.status)
		todos.push({
			id: stepId,
			content: `↳ ${step.description}`,
			status,
		})
	}

	return todos
}

function syncTodoIds(fermentId: string, phaseId: string, writtenTodos: TodoItem[]): void {
	const idMap = getOrCreateIdMap(fermentId, phaseId)
	// After writing, the store has assigned stable IDs. Re-sync our map
	// so subsequent updates can reference the same IDs.
	//
	// writtenTodos[0] is always the header, writtenTodos[1..] are steps.
	// We derive the step list from the active ferment to map indices correctly.
	const ferment = getActive()
	if (!ferment) return
	const phase = ferment.phases.find((p) => p.id === phaseId)
	if (!phase) return

	if (writtenTodos.length > 0) {
		idMap.set("header", writtenTodos[0].id)
	}

	for (let i = 0; i < phase.steps.length && i + 1 < writtenTodos.length; i++) {
		const step = phase.steps[i]
		const todo = writtenTodos[i + 1]
		idMap.set(step.id, todo.id)
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

	const todos = buildPhaseTodos(phase, ferment.id)
	const details = applyWriteTodos({ scope: { kind: "ferment", phaseId: payload.phaseId }, todos })

	// Capture the assigned IDs for future updates
	syncTodoIds(ferment.id, payload.phaseId, details.todos)
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

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Register ferment → todo sync listeners on the given ExtensionAPI.
 *
 * Returns an unsubscribe function that removes all listeners and cleans up state.
 */
export function registerFermentTodoSync(pi: ExtensionAPI): () => void {
	const unsubscribes: Array<() => void> = []

	unsubscribes.push(pi.events.on(FERMENT_EVENTS.PHASE_STARTED, handlePhaseStarted))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.STEP_COMPLETED, handleStepCompleted))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.STEP_FAILED, handleStepFailed))
	unsubscribes.push(pi.events.on(FERMENT_EVENTS.PHASE_COMPLETED, handlePhaseCompleted))

	return () => {
		for (const unsub of unsubscribes) {
			unsub()
		}
		// Clear all ID maps on unsubscribe to avoid memory leaks
		todoIdMaps.clear()
	}
}
