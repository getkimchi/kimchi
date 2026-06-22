/**
 * Unit tests for Ferment → Todo Sync Bridge
 *
 * Validates that ferment lifecycle events correctly populate and update
 * todo lists for each active phase.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment, Phase } from "../../ferment/types.js"
import { __resetTodoStore, applyWriteTodos, getTodosForScope } from "../todos/store.js"
import { FERMENT_EVENTS } from "./domain-events.js"
import { setActive } from "./state.js"
import { registerFermentTodoSync } from "./todo-sync.js"

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

		unsubscribe = registerFermentTodoSync(pi)

		// Emit PHASE_STARTED for phase-1
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Assert: scope should have 1 header + 3 step todos
		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
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

		unsubscribe = registerFermentTodoSync(pi)

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

		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })

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

		unsubscribe = registerFermentTodoSync(pi)

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

		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })

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

	it("manually-added todos are unaffected by ferment sync", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		// Add a manual global todo before registering the sync
		applyWriteTodos({
			scope: { kind: "global" },
			todos: [
				{ content: "Manual global todo", status: "pending" },
				{ content: "Another manual todo", status: "in_progress" },
			],
		})

		unsubscribe = registerFermentTodoSync(pi)

		// Emit PHASE_STARTED for phase-1
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Assert: global scope should still have the manual todos
		const globalTodos = getTodosForScope({ kind: "global" })
		expect(globalTodos).toHaveLength(2)
		expect(globalTodos[0].content).toBe("Manual global todo")
		expect(globalTodos[0].status).toBe("pending")
		expect(globalTodos[1].content).toBe("Another manual todo")
		expect(globalTodos[1].status).toBe("in_progress")

		// Assert: ferment scope should have its own separate todos
		const fermentTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
		expect(fermentTodos).toHaveLength(3) // 1 header + 2 steps
		expect(fermentTodos[0].content).toBe("[Phase 1] Test Phase")
		expect(fermentTodos[1].content).toBe("↳ Step 1")
		expect(fermentTodos[2].content).toBe("↳ Step 2")
	})

	it("phase completion marks remaining todos as completed", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 3)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi)

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

		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })

		// Phase header should be completed
		expect(todos[0].status).toBe("completed")

		// Step 1 should still be completed (was already completed)
		expect(todos[1].status).toBe("completed")

		// Step 2 should still be blocked (was failed, not auto-completed)
		expect(todos[2].status).toBe("blocked")

		// Step 3 should now be completed (was pending, marked completed by PHASE_COMPLETED)
		expect(todos[3].status).toBe("completed")
	})

	it("unsubscribe removes all event listeners", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi)

		// Emit PHASE_STARTED to populate initial todos
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Verify todos were created
		let todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
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

		todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
		expect(todos).toHaveLength(0)
	})

	it("handles multiple step status transitions correctly", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 4)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi)

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

		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })

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

		unsubscribe = registerFermentTodoSync(pi)

		// Emit PHASE_STARTED for a different ferment
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: "different-ferment-id",
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Different Phase",
		})

		// Assert: no todos should be created
		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
		expect(todos).toHaveLength(0)
	})

	it("preserves stable IDs across multiple updates", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi)

		// Emit PHASE_STARTED to populate initial todos
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		// Capture initial IDs
		const initialTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
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
		const updatedTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
		expect(updatedTodos[0].id).toBe(headerIdBefore)
		expect(updatedTodos[1].id).toBe(step1IdBefore)
		expect(updatedTodos[2].id).toBe(step2IdBefore)
	})

	it("ignores PHASE_COMPLETED events from a different ferment (stale-event guard)", () => {
		const { pi, emit } = createFakePI()
		const activeFerment = createTestFerment("phase-1", 2)
		setActive(activeFerment)

		unsubscribe = registerFermentTodoSync(pi)

		// Set up todos for the active ferment
		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: activeFerment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Active Phase",
		})

		const initialTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
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
		const afterStaleEvent = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
		expect(afterStaleEvent).toHaveLength(3)
		expect(afterStaleEvent[0].status).toBe("in_progress")
		expect(afterStaleEvent[1].status).toBe("pending")
		expect(afterStaleEvent[2].status).toBe("pending")
	})

	it("ignores PHASE_COMPLETED events when no ferment is active", () => {
		const { pi, emit } = createFakePI()
		setActive(undefined)

		unsubscribe = registerFermentTodoSync(pi)

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

		unsubscribe = registerFermentTodoSync(pi)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		const initialTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
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

		const updatedTodos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
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

		// Mix global and ferment todos before suspension
		applyWriteTodos({
			scope: { kind: "global" },
			todos: [{ content: "User todo", status: "pending" }],
		})

		unsubscribe = registerFermentTodoSync(pi)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})
		// Add a ferment-step scoped todo (agent-written plan bullet)
		applyWriteTodos({
			scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
			todos: [{ content: "plan bullet", status: "in_progress" }],
		})

		// Sanity: ferment scope has 3 todos, ferment-step scope has 1, global has 1
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(3)
		expect(getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" })).toHaveLength(1)
		expect(getTodosForScope({ kind: "global" })).toHaveLength(1)

		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })

		// Ferment-scoped todos are cleared
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(0)
		expect(getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" })).toHaveLength(0)
		// Global scope is untouched
		expect(getTodosForScope({ kind: "global" })).toHaveLength(1)
		expect(getTodosForScope({ kind: "global" })[0].content).toBe("User todo")
	})

	it("FERMENT_RESUMED restores the snapshot taken at suspension time", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi)

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

		const beforeSuspend = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
		expect(beforeSuspend).toHaveLength(3)
		const phaseHeaderContent = beforeSuspend[0].content
		const step1Content = beforeSuspend[1].content
		const step1Status = beforeSuspend[1].status

		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(0)

		emit(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })

		const afterResume = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
		expect(afterResume).toHaveLength(3)
		expect(afterResume[0].content).toBe(phaseHeaderContent)
		expect(afterResume[1].content).toBe(step1Content)
		expect(afterResume[1].status).toBe(step1Status)
	})

	it("FERMENT_RESUMED without a prior snapshot is a no-op", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})

		expect(() => emit(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })).not.toThrow()

		// Phase scope is still populated from PHASE_STARTED — RESUMED did nothing
		const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
		expect(todos).toHaveLength(3)
	})

	it("FERMENT_COMPLETED clears all ferment-scoped todos and discards any pending snapshot", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		applyWriteTodos({
			scope: { kind: "global" },
			todos: [{ content: "User todo", status: "pending" }],
		})

		unsubscribe = registerFermentTodoSync(pi)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})
		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(0)

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

		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(0)
		expect(getTodosForScope({ kind: "global" })).toHaveLength(1)

		// Subsequent RESUMED for the same ferment should be a no-op (snapshot
		// was discarded by COMPLETED).
		emit(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(0)
	})

	it("suspend/resume cycle preserves stable behavior across multiple cycles", () => {
		const { pi, emit } = createFakePI()
		const ferment = createTestFerment("phase-1", 2)
		setActive(ferment)

		unsubscribe = registerFermentTodoSync(pi)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: ferment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Test Phase",
		})
		const initialContent = getTodosForScope({ kind: "ferment", phaseId: "phase-1" }).map((t) => t.content)

		// First suspend/resume cycle
		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(0)
		emit(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }).map((t) => t.content)).toEqual(initialContent)

		// Second suspend/resume cycle
		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: ferment.id })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(0)
		emit(FERMENT_EVENTS.RESUMED, { fermentId: ferment.id })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" }).map((t) => t.content)).toEqual(initialContent)
	})

	it("ignores FERMENT_SUSPENDED / RESUMED / COMPLETED events for a different ferment", () => {
		const { pi, emit } = createFakePI()
		const activeFerment = createTestFerment("phase-1", 2)
		setActive(activeFerment)

		applyWriteTodos({
			scope: { kind: "global" },
			todos: [{ content: "User todo", status: "pending" }],
		})

		unsubscribe = registerFermentTodoSync(pi)

		emit(FERMENT_EVENTS.PHASE_STARTED, {
			fermentId: activeFerment.id,
			phaseId: "phase-1",
			phaseIndex: 1,
			phaseName: "Active Phase",
		})
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(3)

		// Stale events from another ferment must not affect the active one
		emit(FERMENT_EVENTS.SUSPENDED, { fermentId: "different-ferment" })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(3)

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
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(3)

		emit(FERMENT_EVENTS.RESUMED, { fermentId: "different-ferment" })
		expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(3)
	})
})
