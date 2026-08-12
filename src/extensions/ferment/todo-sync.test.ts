/**
 * Unit tests for Ferment → Todo Sync Bridge
 *
 * Validates that ferment lifecycle events correctly populate and update
 * todo lists for each active phase.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Ferment, Phase } from "../../ferment/types.js"
import { __resetTodoStore, applyWriteTodos, GLOBAL_TODO_SCOPE, getTodosForScope } from "../todos/store.js"
import { FERMENT_EVENTS } from "./domain-events.js"
import { setActive } from "./state.js"
import {
	__getRunningSteps,
	bumpStallCounter,
	getTurnsSinceStepTodoWrite,
	registerFermentTodoSync,
} from "./todo-sync.js"

const TEST_SESSION_ID = "test-session"

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Minimal fake ExtensionAPI with pi.events support */
function createFakePI(): {
	pi: ExtensionAPI
	emit: (channel: string, payload: unknown) => void
} {
	const listeners = new Map<string, Array<(payload: unknown) => void>>()

	const events = {
		on: (channel: string, handler: (payload: unknown) => void) => {
			if (!listeners.has(channel)) {
				listeners.set(channel, [])
			}
			const list = listeners.get(channel)
			if (list) {
				list.push(handler)
			}
			// Return an unsubscribe function
			return () => {
				const list = listeners.get(channel)
				if (list) {
					const idx = list.indexOf(handler)
					if (idx !== -1) list.splice(idx, 1)
				}
			}
		},
		emit: (channel: string, payload: unknown) => {
			const list = listeners.get(channel)
			if (list) {
				for (const fn of list) {
					fn(payload)
				}
			}
		},
	}

	const pi = {
		events,
	} as unknown as ExtensionAPI

	return { pi, emit: events.emit }
}

/** Build a minimal test ferment with one phase and N steps */
function createTestFerment(phaseId: string, stepCount: number): Ferment {
	const steps = Array.from({ length: stepCount }, (_, i) => ({
		id: `step-${i + 1}`,
		index: i + 1,
		description: `Step ${i + 1}`,
		status: "pending" as const,
	}))

	const phase: Phase = {
		id: phaseId,
		index: 1,
		name: "Test Phase",
		goal: "Test phase goal",
		status: "active",
		steps,
	}

	return {
		id: "ferment-test-1",
		name: "Test Ferment",
		status: "running",
		worktree: { path: "/tmp" },
		scoping: {},
		phases: [phase],
		decisions: [],
		memories: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("todo-sync bridge", () => {
	let unsubscribe: (() => void) | undefined

	beforeEach(() => {
		__resetTodoStore()
		setActive(undefined)
	})

	afterEach(() => {
		if (unsubscribe) {
			unsubscribe()
			unsubscribe = undefined
		}
		__resetTodoStore()
		setActive(undefined)
	})

	it("phase activation populates todos with header and steps", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 3)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Emit PHASE_STARTED for phase-1
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Assert: scope should have 1 header + 3 step todos
		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(todos).toHaveLength(4)

		// Header: should show phase name and be in_progress
		expect(todos[0].content).toBe("[Phase 1] Test Phase")
		expect(todos[0].status).toBe("in_progress")
		expect(todos[0].activeForm).toBe("Test Phase")

		// Steps: should be indented with "↳ " prefix and pending
		expect(todos[1].content).toBe("↳ Step 1")
		expect(todos[1].status).toBe("pending")
		expect(todos[2].content).toBe("↳ Step 2")
		expect(todos[2].status).toBe("pending")
		expect(todos[3].content).toBe("↳ Step 3")
		expect(todos[3].status).toBe("pending")

		// All should have stable IDs assigned
		for (const todo of todos) {
			expect(todo.id).toBeGreaterThan(0)
		}
	})

	it("step completion marks the step todo as completed", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 3)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Emit PHASE_STARTED to populate initial todos
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Emit STEP_COMPLETED for step-1
		emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-1",
			stepIndex: 1,
			durationMs: 1000,
			success: true,
		})

		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)

		// Phase header should still be in_progress
		expect(todos[0].status).toBe("in_progress")

		// Step 1 should be completed
		expect(todos[1].content).toBe("↳ Step 1")
		expect(todos[1].status).toBe("completed")

		// Steps 2 and 3 should still be pending
		expect(todos[2].status).toBe("pending")
		expect(todos[3].status).toBe("pending")
	})

	it("step failure marks the step todo as blocked", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 3)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Emit PHASE_STARTED to populate initial todos
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Emit STEP_FAILED for step-2
		emit(FERMENT_EVENTS.STEP_FAILED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-2",
			stepIndex: 2,
			reason: "Test failure",
		})

		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)

		// Phase header should still be in_progress
		expect(todos[0].status).toBe("in_progress")

		// Step 1 should still be pending
		expect(todos[1].status).toBe("pending")

		// Step 2 should be blocked
		expect(todos[2].content).toBe("↳ Step 2")
		expect(todos[2].status).toBe("blocked")

		// Step 3 should still be pending
		expect(todos[3].status).toBe("pending")
	})

	it("global todos created during a phase persist until the next phase starts", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Emit PHASE_STARTED for phase-1
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Add manual global todos during the phase (model-created)
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [
					{ content: "Manual global todo", status: "pending" },
					{ content: "Another manual todo", status: "in_progress" },
				],
			},
			TEST_SESSION_ID,
		)

		// Global todos persist during the phase
		const globalTodos = getTodosForScope({ kind: "global" }, TEST_SESSION_ID)
		expect(globalTodos).toHaveLength(2)
		expect(globalTodos[0].content).toBe("Manual global todo")
		expect(globalTodos[0].status).toBe("pending")
		expect(globalTodos[1].content).toBe("Another manual todo")
		expect(globalTodos[1].status).toBe("in_progress")

		// Assert: ferment scope should have its own separate todos
		const fermentTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(fermentTodos).toHaveLength(3) // 1 header + 2 steps
		expect(fermentTodos[0].content).toBe("[Phase 1] Test Phase")
		expect(fermentTodos[1].content).toBe("↳ Step 1")
		expect(fermentTodos[2].content).toBe("↳ Step 2")
	})

	it("phase completion clears ferment-scoped todos entirely", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 3)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Emit PHASE_STARTED to populate initial todos
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Complete step 1
		emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-1",
			stepIndex: 1,
			durationMs: 1000,
			success: true,
		})

		// Fail step 2 (should be blocked)
		emit(FERMENT_EVENTS.STEP_FAILED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-2",
			stepIndex: 2,
			reason: "Test failure",
		})

		// Emit PHASE_COMPLETED (step 3 was never touched)
		emit(FERMENT_EVENTS.PHASE_COMPLETED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
			durationMs: 5000,
			deltaInputTokens: 1000,
			deltaOutputTokens: 500,
			blockRetries: 0,
		})

		// Ferment-scoped todos should be fully cleared after phase completion.
		// Previously they were marked completed and left in the store, which
		// added noise to the model's ## Current Todos block and could confuse
		// the model if a new phase reused the same phaseId.
		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(todos).toHaveLength(0)
	})

	it("unsubscribe removes all event listeners", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Emit PHASE_STARTED to populate initial todos
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Verify todos were created
		let todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(todos).toHaveLength(3)

		// Unsubscribe
		unsubscribe()
		unsubscribe = undefined

		// Reset store to clear todos
		__resetTodoStore()

		// Emit PHASE_STARTED again — should NOT create todos
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(todos).toHaveLength(0)
	})

	it("handles multiple step status transitions correctly", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 4)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Emit PHASE_STARTED to populate initial todos
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Multi-Step Phase",
		})

		// Complete step 1
		emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-1",
			stepIndex: 1,
			durationMs: 1000,
			success: true,
		})

		// Complete step 2
		emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-2",
			stepIndex: 2,
			durationMs: 1500,
			success: true,
		})

		// Fail step 3
		emit(FERMENT_EVENTS.STEP_FAILED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-3",
			stepIndex: 3,
			reason: "Test failure",
		})

		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)

		// Phase header should still be in_progress
		expect(todos[0].status).toBe("in_progress")

		// Steps 1 and 2 should be completed
		expect(todos[1].status).toBe("completed")
		expect(todos[2].status).toBe("completed")

		// Step 3 should be blocked
		expect(todos[3].status).toBe("blocked")

		// Step 4 should still be pending
		expect(todos[4].status).toBe("pending")
	})

	it("ignores events for different ferments", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Emit PHASE_STARTED for a different ferment
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: "different-ferment-id",
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Different Phase",
		})

		// Assert: no todos should be created
		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(todos).toHaveLength(0)
	})

	it("preserves stable IDs across multiple updates", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Emit PHASE_STARTED to populate initial todos
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Capture initial IDs
		const initialTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		const headerIdBefore = initialTodos[0].id
		const step1IdBefore = initialTodos[1].id
		const step2IdBefore = initialTodos[2].id

		// Complete step 1
		emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-1",
			stepIndex: 1,
			durationMs: 1000,
			success: true,
		})

		// Fail step 2
		emit(FERMENT_EVENTS.STEP_FAILED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-2",
			stepIndex: 2,
			reason: "Test failure",
		})

		// Assert: IDs should remain stable
		const updatedTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(updatedTodos[0].id).toBe(headerIdBefore)
		expect(updatedTodos[1].id).toBe(step1IdBefore)
		expect(updatedTodos[2].id).toBe(step2IdBefore)
	})

	it("ignores PHASE_COMPLETED events from a different ferment (stale-event guard)", () => {
		const { pi, emit } = createFakePI()
		const activeFerment = createTestFerment("phase-1", 2)
		setActive(activeFerment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Set up todos for the active ferment
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: activeFerment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Active Phase",
		})

		const initialTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(initialTodos).toHaveLength(3) // header + 2 steps
		expect(initialTodos[0].status).toBe("in_progress")
		expect(initialTodos[1].status).toBe("pending")
		expect(initialTodos[2].status).toBe("pending")

		// Simulate a stale PHASE_COMPLETED arriving from a previous ferment that
		// happens to share the same phaseId. The guard must reject it.
		emit(FERMENT_EVENTS.PHASE_COMPLETED, {
			fermentId: "different-ferment-id",
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Stale Phase",
			durationMs: 1000,
			deltaInputTokens: 0,
			deltaOutputTokens: 0,
			blockRetries: 0,
		})

		// Assert: todos for the active ferment are untouched
		const afterStaleEvent = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(afterStaleEvent).toHaveLength(3)
		expect(afterStaleEvent[0].status).toBe("in_progress")
		expect(afterStaleEvent[1].status).toBe("pending")
		expect(afterStaleEvent[2].status).toBe("pending")
	})

	it("ignores PHASE_COMPLETED events when no ferment is active", () => {
		const { pi, emit } = createFakePI()
		setActive(undefined)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Should not throw even though there's no active ferment and no todos.
		expect(() =>
			emit(FERMENT_EVENTS.PHASE_COMPLETED, {
				fermentId: "any-ferment",
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Orphan Phase",
				durationMs: 0,
				deltaInputTokens: 0,
				deltaOutputTokens: 0,
				blockRetries: 0,
			}),
		).not.toThrow()
	})

	it("preserves stable IDs even when the store reorders written todos", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 3)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		const initialTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		const headerIdBefore = initialTodos[0].id
		const step1IdBefore = initialTodos[1].id
		const step3IdBefore = initialTodos[3].id

		// Interleave a step completion between two non-adjacent steps.
		// Content-based correlation should still match step-3 correctly.
		emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-3",
			stepIndex: 3,
			durationMs: 1000,
			success: true,
		})

		const updatedTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(updatedTodos[0].id).toBe(headerIdBefore)
		expect(updatedTodos[1].id).toBe(step1IdBefore)
		expect(updatedTodos[3].id).toBe(step3IdBefore)
		expect(updatedTodos[3].status).toBe("completed")
	})

	// ─── Suspend / resume / finish ─────────────────────────────────────────────

	it("FERMENT_SUSPENDED clears all ferment-scoped todos and preserves global scope", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Add global + ferment-step todos after phase starts (model-created during work)
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [{ content: "User todo", status: "pending" }],
			},
			TEST_SESSION_ID,
		)
		// Add a ferment-step scoped todo (agent-written plan bullet)
		applyWriteTodos(
			{
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
				todos: [{ content: "plan bullet", status: "in_progress" }],
			},
			TEST_SESSION_ID,
		)

		// Sanity: ferment scope has 3 todos, ferment-step scope has 1, global has 1
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(3)
		const stepScope = { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" } as const
		expect(getTodosForScope(stepScope, TEST_SESSION_ID)).toHaveLength(1)
		expect(getTodosForScope({ kind: "global" }, TEST_SESSION_ID)).toHaveLength(1)

		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })

		// Ferment-scoped todos are cleared
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(0)
		expect(getTodosForScope(stepScope, TEST_SESSION_ID)).toHaveLength(0)
		// Global scope is untouched
		expect(getTodosForScope({ kind: "global" }, TEST_SESSION_ID)).toHaveLength(1)
		expect(getTodosForScope({ kind: "global" }, TEST_SESSION_ID)[0].content).toBe("User todo")
	})

	it("FERMENT_RESUMED restores the snapshot taken at suspension time", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})
		emit(FERMENT_EVENTS.STEP_COMPLETED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-1",
			stepIndex: 1,
			durationMs: 1000,
			success: true,
		})

		const beforeSuspend = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(beforeSuspend).toHaveLength(3)
		const phaseHeaderContent = beforeSuspend[0].content
		const step1Content = beforeSuspend[1].content
		const step1Status = beforeSuspend[1].status

		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(0)

		emit(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })

		const afterResume = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(afterResume).toHaveLength(3)
		expect(afterResume[0].content).toBe(phaseHeaderContent)
		expect(afterResume[1].content).toBe(step1Content)
		expect(afterResume[1].status).toBe(step1Status)
	})

	it("FERMENT_RESUMED without a prior snapshot is a no-op", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		expect(() => emit(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })).not.toThrow()

		// Phase scope is still populated from PHASE_STARTED — RESUMED did nothing
		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(todos).toHaveLength(3)
	})

	it("FERMENT_COMPLETED clears all ferment-scoped todos and discards any pending snapshot", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Add a global todo after phase starts (model-created during work)
		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [{ content: "User todo", status: "pending" }],
			},
			TEST_SESSION_ID,
		)

		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(0)

		emit(FERMENT_EVENTS.COMPLETED, {
			fermentId: ferment.id,
			name: "Test Ferment",
			phaseCount: 1,
			durationMs: 5000,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			steeringCount: 0,
			blockRetries: 0,
		})

		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(0)
		expect(getTodosForScope({ kind: "global" }, TEST_SESSION_ID)).toHaveLength(1)

		// Subsequent RESUMED for the same ferment should be a no-op (snapshot
		// was discarded by COMPLETED).
		emit(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(0)
	})

	it("suspend/resume cycle preserves stable behavior across multiple cycles", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})
		const phaseScope = { kind: "ferment", phaseId: "phase-1" } as const
		const initialContent = getTodosForScope(phaseScope, TEST_SESSION_ID).map((t) => t.content)

		// First suspend/resume cycle
		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })
		expect(getTodosForScope(phaseScope, TEST_SESSION_ID)).toHaveLength(0)
		emit(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })
		expect(getTodosForScope(phaseScope, TEST_SESSION_ID).map((t) => t.content)).toEqual(initialContent)

		// Second suspend/resume cycle
		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })
		expect(getTodosForScope(phaseScope, TEST_SESSION_ID)).toHaveLength(0)
		emit(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })
		expect(getTodosForScope(phaseScope, TEST_SESSION_ID).map((t) => t.content)).toEqual(initialContent)
	})

	it("ignores FERMENT_SUSPENDED / RESUMED / COMPLETED events for a different ferment", () => {
		const { pi, emit } = createFakePI()
		const activeFerment = createTestFerment("phase-1", 2)
		setActive(activeFerment)

		applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: [{ content: "User todo", status: "pending" }],
			},
			TEST_SESSION_ID,
		)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: activeFerment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Active Phase",
		})
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(3)

		// Stale events from another ferment must not affect the active one
		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: "different-ferment" })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(3)

		emit(FERMENT_EVENTS.COMPLETED, {
			fermentId: "different-ferment",
			name: "Different",
			phaseCount: 1,
			durationMs: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			steeringCount: 0,
			blockRetries: 0,
		})
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(3)

		emit(FERMENT_EVENTS.RESUMED, { fermentId: "different-ferment" })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(3)
	})

	describe("cross-session isolation", () => {
		it("isolates running steps and stall counters between sessions", () => {
			const { pi: piA, emit: emitA } = createFakePI()
			const { pi: piB, emit: emitB } = createFakePI()
			const ferment = createTestFerment("phase-1", 2)
			setActive(ferment)

			const unsubA = registerFermentTodoSync(piA, "session-a")
			const unsubB = registerFermentTodoSync(piB, "session-b")

			emitA(FERMENT_EVENTS.PHASE_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Test Phase",
			})
			emitA(FERMENT_EVENTS.STEP_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-1",
				stepIndex: 1,
			})
			emitB(FERMENT_EVENTS.PHASE_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Test Phase",
			})
			emitB(FERMENT_EVENTS.STEP_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-1",
				stepIndex: 1,
			})

			expect(__getRunningSteps("session-a").size).toBe(1)
			expect(__getRunningSteps("session-b").size).toBe(1)

			bumpStallCounter("session-a")
			bumpStallCounter("session-a")
			expect(getTurnsSinceStepTodoWrite("session-a")).toBe(2)
			expect(getTurnsSinceStepTodoWrite("session-b")).toBe(0)

			// A ferment-step todo written for session-a should reset A's counter only.
			applyWriteTodos(
				{
					scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
					todos: [{ content: "agent bullet", status: "in_progress" }],
				},
				"session-a",
			)
			expect(getTurnsSinceStepTodoWrite("session-a")).toBe(0)
			expect(getTurnsSinceStepTodoWrite("session-b")).toBe(0)

			unsubA()
			unsubB()
		})

		it("isolates suspend/resume snapshots between sessions", () => {
			const { pi: piA, emit: emitA } = createFakePI()
			const { pi: piB, emit: emitB } = createFakePI()
			const ferment = createTestFerment("phase-1", 2)
			setActive(ferment)

			const unsubA = registerFermentTodoSync(piA, "session-a")
			const unsubB = registerFermentTodoSync(piB, "session-b")

			emitA(FERMENT_EVENTS.PHASE_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Test Phase",
			})
			emitA(FERMENT_EVENTS.STEP_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-1",
				stepIndex: 1,
			})
			emitB(FERMENT_EVENTS.PHASE_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Test Phase",
			})
			emitB(FERMENT_EVENTS.STEP_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-1",
				stepIndex: 1,
			})

			// Complete step 1 only in session A.
			emitA(FERMENT_EVENTS.STEP_COMPLETED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-1",
				stepIndex: 1,
				durationMs: 1000,
				success: true,
			})

			const scope = { kind: "ferment", phaseId: "phase-1" } as const
			expect(getTodosForScope(scope, "session-a")[1]?.status).toBe("completed")
			expect(getTodosForScope(scope, "session-b")[1]?.status).toBe("pending")

			// Suspend both sessions.
			emitA(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })
			emitB(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })
			expect(getTodosForScope(scope, "session-a")).toHaveLength(0)
			expect(getTodosForScope(scope, "session-b")).toHaveLength(0)

			// Resume session A: it restores its own completed snapshot.
			emitA(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })
			expect(getTodosForScope(scope, "session-a")[1]?.status).toBe("completed")
			expect(getTodosForScope(scope, "session-b")).toHaveLength(0)

			unsubA()
			unsubB()
		})

		it("unsubscribe only clears the bridge's own session state", () => {
			const { pi: piA, emit: emitA } = createFakePI()
			const { pi: piB, emit: emitB } = createFakePI()
			const ferment = createTestFerment("phase-1", 1)
			setActive(ferment)

			const unsubA = registerFermentTodoSync(piA, "session-a")
			const unsubB = registerFermentTodoSync(piB, "session-b")

			emitA(FERMENT_EVENTS.PHASE_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Test Phase",
			})
			emitB(FERMENT_EVENTS.PHASE_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Test Phase",
			})
			emitB(FERMENT_EVENTS.STEP_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-1",
				stepIndex: 1,
			})

			unsubA()

			// Session B should still have a running step and respond to events.
			emitB(FERMENT_EVENTS.STEP_COMPLETED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-1",
				stepIndex: 1,
				durationMs: 1000,
				success: true,
			})
			expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, "session-b")[1]?.status).toBe("completed")

			unsubB()
		})

		it("handles interleaved concurrent events without cross-session contamination", () => {
			const { pi: piA, emit: emitA } = createFakePI()
			const { pi: piB, emit: emitB } = createFakePI()
			const ferment = createTestFerment("phase-1", 2)
			setActive(ferment)

			const unsubA = registerFermentTodoSync(piA, "session-a")
			const unsubB = registerFermentTodoSync(piB, "session-b")

			// Interleave phase and step-start events across the two sessions.
			emitA(FERMENT_EVENTS.PHASE_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Test Phase",
			})
			emitB(FERMENT_EVENTS.PHASE_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Test Phase",
			})
			emitA(FERMENT_EVENTS.STEP_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-1",
				stepIndex: 1,
			})
			emitB(FERMENT_EVENTS.STEP_STARTED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-2",
				stepIndex: 2,
			})

			// Complete opposite steps in each session.
			emitA(FERMENT_EVENTS.STEP_COMPLETED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-1",
				stepIndex: 1,
				durationMs: 1000,
				success: true,
			})
			emitB(FERMENT_EVENTS.STEP_COMPLETED, {
				fermentId: ferment.id,
				phaseId: "phase-1",
				stepId: "step-2",
				stepIndex: 2,
				durationMs: 1000,
				success: true,
			})

			const scope = { kind: "ferment", phaseId: "phase-1" } as const
			const todosA = getTodosForScope(scope, "session-a")
			const todosB = getTodosForScope(scope, "session-b")

			// Session A completed step-1 only.
			expect(todosA[1]?.content).toBe("↳ Step 1")
			expect(todosA[1]?.status).toBe("completed")
			expect(todosA[2]?.content).toBe("↳ Step 2")
			expect(todosA[2]?.status).toBe("pending")

			// Session B completed step-2 only.
			expect(todosB[1]?.content).toBe("↳ Step 1")
			expect(todosB[1]?.status).toBe("pending")
			expect(todosB[2]?.content).toBe("↳ Step 2")
			expect(todosB[2]?.status).toBe("completed")

			unsubA()
			unsubB()
		})
	})
})

describe("scope bleed prevention", () => {
	let unsubscribe: (() => void) | undefined

	beforeEach(() => {
		__resetTodoStore()
		setActive(undefined)
	})

	afterEach(() => {
		if (unsubscribe) {
			unsubscribe()
			unsubscribe = undefined
		}
		__resetTodoStore()
		setActive(undefined)
	})

	it("preserves global-scope todos on PHASE_STARTED", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		// Write some global todos that should persist when a new phase starts.
		// Global todos are user/model-owned and survive phase/step boundaries.
		applyWriteTodos(
			{ scope: { kind: "global" }, todos: [{ content: "stale global todo", status: "pending" }] },
			TEST_SESSION_ID,
		)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toHaveLength(1)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Global todos should persist — they are not wiped by phase boundaries.
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toHaveLength(1)

		// Ferment-scoped phase todos should be populated
		const phaseTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)
		expect(phaseTodos).toHaveLength(3) // header + 2 steps
	})

	it("preserves global-scope todos on STEP_STARTED", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Write some global todos after phase started
		applyWriteTodos(
			{ scope: { kind: "global" }, todos: [{ content: "stale global todo", status: "pending" }] },
			TEST_SESSION_ID,
		)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toHaveLength(1)

		emit(FERMENT_EVENTS.STEP_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-1",
			stepIndex: 1,
		})

		// Global todos should persist — they are not wiped by step boundaries.
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toHaveLength(1)
	})

	it("seeds the step scope with an in_progress anchor on STEP_STARTED", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})
		emit(FERMENT_EVENTS.STEP_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-1",
			stepIndex: 1,
		})

		// The step scope starts with a single anchor: the step's own title as
		// an in_progress header. The model is expected to append sub-tasks
		// beneath it — not to restate the phase plan (observed behaviour).
		const stepTodos = getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" }, TEST_SESSION_ID)
		expect(stepTodos).toHaveLength(1)
		expect(stepTodos[0].content).toBe("[Step 1] Step 1")
		expect(stepTodos[0].status).toBe("in_progress")
	})

	it("does not reseed the step scope when a restarted step already has todos", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})
		// Model wrote its own sub-tasks before the step was (re)started.
		applyWriteTodos(
			{
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
				todos: [{ content: "run pnpm install", status: "in_progress" }],
			},
			TEST_SESSION_ID,
		)

		emit(FERMENT_EVENTS.STEP_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-1",
			stepIndex: 1,
		})

		const stepTodos = getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" }, TEST_SESSION_ID)
		expect(stepTodos).toHaveLength(1)
		expect(stepTodos[0].content).toBe("run pnpm install")
	})

	it("clears ferment-scoped todos on PHASE_COMPLETED", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		const phaseScope = { kind: "ferment" as const, phaseId: "phase-1" }
		expect(getTodosForScope(phaseScope, TEST_SESSION_ID)).toHaveLength(3)

		// Complete the phase with updated ferment state (steps done)
		const completedFerment: Ferment = {
			...ferment,
			phases: ferment.phases.map((p) => ({
				...p,
				steps: p.steps.map((s) => ({ ...s, status: "done" as const })),
			})),
		}
		setActive(completedFerment)
		emit(FERMENT_EVENTS.PHASE_COMPLETED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
		})

		// Ferment-scoped todos should be fully cleared, not just marked completed
		expect(getTodosForScope(phaseScope, TEST_SESSION_ID)).toHaveLength(0)
	})

	it("does not clear global todos mid-step (only at transition boundaries)", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})
		emit(FERMENT_EVENTS.STEP_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			stepId: "step-1",
			stepIndex: 1,
		})

		// Model creates global todos during the step — should persist until next transition
		applyWriteTodos(
			{ scope: { kind: "global" }, todos: [{ content: "active global todo", status: "pending" }] },
			TEST_SESSION_ID,
		)
		expect(getTodosForScope(GLOBAL_TODO_SCOPE, TEST_SESSION_ID)).toHaveLength(1)
	})
})

describe("sweepTerminalPhaseScopes", () => {
	let unsubscribe: (() => void) | undefined

	beforeEach(() => {
		__resetTodoStore()
		setActive(undefined)
	})

	afterEach(() => {
		if (unsubscribe) {
			unsubscribe()
			unsubscribe = undefined
		}
		__resetTodoStore()
		setActive(undefined)
	})

	/** Build a ferment with multiple phases, some terminal, some active. */
	function createMultiPhaseFerment(): Ferment {
		return {
			id: "ferment-multi",
			name: "Multi Phase Ferment",
			status: "running",
			worktree: { path: "/tmp" },
			scoping: {},
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Phase One",
					goal: "Goal 1",
					status: "completed",
					steps: [{ id: "step-1", index: 1, description: "Step 1", status: "done" }],
				},
				{
					id: "phase-2",
					index: 2,
					name: "Phase Two",
					goal: "Goal 2",
					status: "active",
					steps: [{ id: "step-1", index: 1, description: "Step 1", status: "pending" }],
				},
			],
			decisions: [],
			memories: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}
	}

	it("clears ferment scope for a terminal phase when a new phase starts", () => {
		const { pi, emit } = createFakePI()
		const ferment = createMultiPhaseFerment()
		setActive(ferment)

		// Simulate a missed PHASE_COMPLETED: phase-1 has a leftover ferment scope.
		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-1" },
				todos: [{ content: "[Phase 1] Stale", status: "in_progress" }],
			},
			TEST_SESSION_ID,
		)
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(1)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-2",
			phaseIndex: 2,
			phaseName: "Phase Two",
		})

		// Stale phase-1 scope should be swept.
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(0)
		// New phase-2 scope should be populated.
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-2" }, TEST_SESSION_ID)).toHaveLength(2)
	})

	it("clears stale ferment-step scope for a terminal phase", () => {
		const { pi, emit } = createFakePI()
		const ferment = createMultiPhaseFerment()
		setActive(ferment)

		// Simulate a leftover step scope from phase-1.
		applyWriteTodos(
			{
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
				todos: [{ content: "sub-task", status: "pending" }],
			},
			TEST_SESSION_ID,
		)
		expect(
			getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" }, TEST_SESSION_ID),
		).toHaveLength(1)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-2",
			phaseIndex: 2,
			phaseName: "Phase Two",
		})

		expect(
			getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" }, TEST_SESSION_ID),
		).toHaveLength(0)
	})

	it("preserves scopes for phases in the same parallel group", () => {
		const { pi, emit } = createFakePI()
		const ferment = createMultiPhaseFerment()
		// Mark both phases as in group 1 (parallel).
		ferment.phases[0].groupIndex = 1
		ferment.phases[1].groupIndex = 1
		// phase-1 is completed but in the same group as phase-2.
		setActive(ferment)

		applyWriteTodos(
			{
				scope: { kind: "ferment", phaseId: "phase-1" },
				todos: [{ content: "[Phase 1] Parallel", status: "completed" }],
			},
			TEST_SESSION_ID,
		)

		unsubscribe = registerFermentTodoSync(pi, TEST_SESSION_ID)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-2",
			phaseIndex: 2,
			phaseName: "Phase Two",
		})

		// phase-1 scope should survive — same parallel group.
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }, TEST_SESSION_ID)).toHaveLength(1)
	})
})
