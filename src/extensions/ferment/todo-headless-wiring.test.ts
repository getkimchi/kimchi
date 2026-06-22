/**
 * Integration test: ferment activation → todo store → headless prompt block
 *
 * Validates the full chain without a real LLM:
 *
 *   emitFermentDomainEvent(activate_phase)
 *     → pi.events (real EventBus)
 *       → registerFermentTodoSync (bridge)
 *         → applyWriteTodos (todo store)
 *           → renderTodoStateMarkdown (headless prompt block)
 *
 * This is the path that runs in --ferment-oneshot headless mode. Every link in
 * the chain is exercised with real implementations — no mocks for the event
 * bus, bridge, store, or prompt renderer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createEventBus } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import {
	__test_renderTodoStateMarkdown,
	currentSessionHasUI,
	renderTodoStateBlock,
	setCurrentSessionHasUI,
} from "../todos/prompt-block.js"
import { __resetTodoStore, applyWriteTodos, getTodosForScope, resolveTodoScope } from "../todos/store.js"
import { emitFermentDomainEvent } from "./domain-events-emitter.js"
import { setActive } from "./state.js"
import {
	__getRunningSteps,
	bumpStallCounter,
	getTurnsSinceStepTodoWrite,
	registerFermentTodoSync,
} from "./todo-sync.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-wire-test",
		name: "Wiring Test Ferment",
		status: "running",
		worktree: { path: "/tmp" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Implementation",
				goal: "do the work",
				status: "active",
				steps: [
					{ id: "step-1", index: 1, description: "Write the code", status: "pending" },
					{ id: "step-2", index: 2, description: "Run the tests", status: "pending" },
				],
			},
		],
		decisions: [],
		memories: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	}
}

/** Minimal ExtensionAPI stub that delegates events to a real EventBus. */
function makePiWithRealEventBus(): { pi: ExtensionAPI; unsubscribe: () => void } {
	const bus = createEventBus()
	const pi = { events: bus } as unknown as ExtensionAPI
	const unsubscribe = registerFermentTodoSync(pi)
	return { pi, unsubscribe }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ferment → todo → headless prompt wiring", () => {
	beforeEach(() => {
		__resetTodoStore()
		setActive(undefined)
		setCurrentSessionHasUI(false) // simulate headless / one-shot mode
	})

	afterEach(() => {
		setActive(undefined)
		__resetTodoStore()
		setCurrentSessionHasUI(true) // reset to safe interactive default
	})

	it("currentSessionHasUI starts as false in headless mode (setCurrentSessionHasUI wires correctly)", () => {
		expect(currentSessionHasUI).toBe(false)
	})

	it("renderTodoStateBlock returns undefined when no todos exist yet", () => {
		// Before any phase starts, store is empty → block should not inject anything.
		expect(renderTodoStateBlock()).toBeUndefined()
	})

	it("activate_phase event populates the todo store via the bridge", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			// Emit the same event that activate_ferment_phase tool fires after
			// applyAndPersist({ type: "activate_phase", phaseId: "phase-1" }).
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)

			const todos = getTodosForScope({ kind: "ferment", phaseId: "phase-1" })
			// Phase header + 2 steps
			expect(todos).toHaveLength(3)
			expect(todos[0].content).toBe("[Phase 1] Implementation")
			expect(todos[0].status).toBe("in_progress")
			expect(todos[1].content).toBe("↳ Write the code")
			expect(todos[1].status).toBe("pending")
			expect(todos[2].content).toBe("↳ Run the tests")
			expect(todos[2].status).toBe("pending")
		} finally {
			unsubscribe()
		}
	})

	it("renderTodoStateBlock returns the ## Current Todos block after phase activation", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)

			const md = renderTodoStateBlock()
			expect(md).toBeDefined()
			expect(md).toContain("## Current Todos")
			expect(md).toContain("**[Phase 1] Implementation**")
			expect(md).toContain("- [ ] ↳ Write the code")
			expect(md).toContain("- [ ] ↳ Run the tests")
		} finally {
			unsubscribe()
		}
	})

	it("renderTodoStateBlock returns undefined when UI is present (widget handles it)", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)

			// Store is populated.
			expect(getTodosForScope({ kind: "ferment", phaseId: "phase-1" })).toHaveLength(3)

			// Switching to interactive mode: renderTodoStateBlock gates on currentSessionHasUI.
			setCurrentSessionHasUI(true)
			expect(renderTodoStateBlock()).toBeUndefined()
		} finally {
			unsubscribe()
		}
	})

	it("start_step event auto-scopes subsequent todo calls to the ferment-step scope", () => {
		const ferment = makeFerment({
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Implementation",
					goal: "do the work",
					status: "active",
					steps: [
						{ id: "step-1", index: 1, description: "Write the code", status: "running" },
						{ id: "step-2", index: 2, description: "Run the tests", status: "pending" },
					],
				},
			],
		})
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }, ferment)

			// Scope-less todo call should resolve to the running step's ferment-step scope
			const resolved = resolveTodoScope(undefined)
			expect(resolved).toEqual({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" })

			// Writing without explicit scope should go to ferment-step
			applyWriteTodos({ todos: [{ content: "do something", status: "pending" }] })
			expect(getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" })).toHaveLength(1)
			expect(getTodosForScope({ kind: "global" })).toHaveLength(0)
		} finally {
			unsubscribe()
		}
	})

	it("scope resolves to global when no step is running", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			// No step started — should resolve to global
			const resolved = resolveTodoScope(undefined)
			expect(resolved).toEqual({ kind: "global" })
		} finally {
			unsubscribe()
		}
	})

	it("complete_step event clears the ferment-step scope and resets auto-scope to global", () => {
		const ferment = makeFerment({
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Implementation",
					goal: "do the work",
					status: "active",
					steps: [
						{ id: "step-1", index: 1, description: "Write the code", status: "running" },
						{ id: "step-2", index: 2, description: "Run the tests", status: "pending" },
					],
				},
			],
		})
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }, ferment)

			// Simulate model writing todos (without scope — auto-scoped)
			applyWriteTodos({ todos: [{ content: "plan item", status: "in_progress" }] })
			expect(getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" })).toHaveLength(1)

			// Complete the step
			const completedFerment: Ferment = {
				...ferment,
				phases: ferment.phases.map((p) => ({
					...p,
					steps: p.steps.map((s) => (s.id === "step-1" ? { ...s, status: "done" as const } : s)),
				})),
			}
			setActive(completedFerment)
			emitFermentDomainEvent(
				pi.events,
				{ type: "complete_step", phaseId: "phase-1", stepId: "step-1" },
				completedFerment,
			)

			// Step-level todos should be cleared
			expect(getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" })).toHaveLength(0)
			// Scope should revert to global
			expect(resolveTodoScope(undefined)).toEqual({ kind: "global" })
		} finally {
			unsubscribe()
		}
	})

	it("fail_step event clears the ferment-step scope and resets auto-scope to global", () => {
		const ferment = makeFerment({
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Implementation",
					goal: "do the work",
					status: "active",
					steps: [
						{ id: "step-1", index: 1, description: "Write the code", status: "running" },
						{ id: "step-2", index: 2, description: "Run the tests", status: "pending" },
					],
				},
			],
		})
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }, ferment)

			applyWriteTodos({ todos: [{ content: "plan item", status: "in_progress" }] })
			expect(getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" })).toHaveLength(1)

			const failedFerment: Ferment = {
				...ferment,
				phases: ferment.phases.map((p) => ({
					...p,
					steps: p.steps.map((s) => (s.id === "step-1" ? { ...s, status: "failed" as const } : s)),
				})),
			}
			setActive(failedFerment)
			emitFermentDomainEvent(
				pi.events,
				{ type: "fail_step", phaseId: "phase-1", stepId: "step-1", error: "oops" },
				failedFerment,
			)

			expect(getTodosForScope({ kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" })).toHaveLength(0)
			expect(resolveTodoScope(undefined)).toEqual({ kind: "global" })
		} finally {
			unsubscribe()
		}
	})

	it("complete_step event updates the step todo status in the block", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)

			// Simulate complete_step for step-1
			const completedFerment: Ferment = {
				...ferment,
				phases: ferment.phases.map((p) => ({
					...p,
					steps: p.steps.map((s) => (s.id === "step-1" ? { ...s, status: "done" as const } : s)),
				})),
			}
			setActive(completedFerment)
			emitFermentDomainEvent(
				pi.events,
				{ type: "complete_step", phaseId: "phase-1", stepId: "step-1" },
				completedFerment,
			)

			const md = renderTodoStateBlock()
			expect(md).toContain("- [x] ↳ Write the code")
			expect(md).toContain("- [ ] ↳ Run the tests")
		} finally {
			unsubscribe()
		}
	})

	it("complete_ferment event clears all ferment-scoped todos from the prompt block", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			expect(renderTodoStateBlock()).toContain("## Current Todos")

			const completedFerment: Ferment = { ...ferment, status: "complete" }
			setActive(completedFerment)
			emitFermentDomainEvent(pi.events, { type: "complete_ferment" }, completedFerment)

			// All ferment-scoped todos cleared → block returns undefined.
			expect(renderTodoStateBlock()).toBeUndefined()
		} finally {
			unsubscribe()
		}
	})

	it("pause suspends todos (clears block) and resume restores them", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			expect(renderTodoStateBlock()).toContain("## Current Todos")

			// Pause clears todos from the store (but snapshots internally).
			emitFermentDomainEvent(pi.events, { type: "pause" }, ferment)
			expect(renderTodoStateBlock()).toBeUndefined()

			// Resume restores the snapshot.
			emitFermentDomainEvent(pi.events, { type: "resume" }, ferment)
			const md = renderTodoStateBlock()
			expect(md).toContain("## Current Todos")
			expect(md).toContain("**[Phase 1] Implementation**")
		} finally {
			unsubscribe()
		}
	})
})

describe("stall detection via step todo write tracking", () => {
	beforeEach(() => {
		__resetTodoStore()
		setActive(undefined)
		setCurrentSessionHasUI(false)
	})

	afterEach(() => {
		setActive(undefined)
		__resetTodoStore()
		setCurrentSessionHasUI(true)
	})

	it("stall counter starts at 0 and increments with bumpStallCounter", () => {
		const ferment = makeFerment({
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Build",
					goal: "build it",
					status: "active",
					steps: [{ id: "step-1", index: 1, description: "Write code", status: "running" }],
				},
			],
		})
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }, ferment)

			expect(getTurnsSinceStepTodoWrite()).toBe(0)
			bumpStallCounter()
			expect(getTurnsSinceStepTodoWrite()).toBe(1)
			bumpStallCounter()
			bumpStallCounter()
			expect(getTurnsSinceStepTodoWrite()).toBe(3)
		} finally {
			unsubscribe()
		}
	})

	it("stall counter resets when step-scope todos are written", () => {
		const ferment = makeFerment({
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Build",
					goal: "build it",
					status: "active",
					steps: [{ id: "step-1", index: 1, description: "Write code", status: "running" }],
				},
			],
		})
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }, ferment)

			bumpStallCounter()
			bumpStallCounter()
			bumpStallCounter()
			expect(getTurnsSinceStepTodoWrite()).toBe(3)

			// Writing to the step scope resets the counter
			applyWriteTodos({
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
				todos: [{ content: "plan item", status: "pending" }],
			})
			expect(getTurnsSinceStepTodoWrite()).toBe(0)
		} finally {
			unsubscribe()
		}
	})

	it("stall warning appears in rendered markdown after threshold", () => {
		const ferment = makeFerment({
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Build",
					goal: "build it",
					status: "active",
					steps: [{ id: "step-1", index: 1, description: "Write code", status: "running" }],
				},
			],
		})
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }, ferment)

			// Populate step todos so markdown renders
			applyWriteTodos({
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
				todos: [{ content: "plan item", status: "in_progress" }],
			})

			// Bump past threshold (5 turns)
			for (let i = 0; i < 6; i++) bumpStallCounter()

			const md = __test_renderTodoStateMarkdown()
			expect(md).toContain("\u26a0 Step todos have not been updated for 6 turns")
			expect(md).toContain("reassess your approach")
		} finally {
			unsubscribe()
		}
	})

	it("stall warning does NOT appear below threshold", () => {
		const ferment = makeFerment({
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Build",
					goal: "build it",
					status: "active",
					steps: [{ id: "step-1", index: 1, description: "Write code", status: "running" }],
				},
			],
		})
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }, ferment)

			applyWriteTodos({
				scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
				todos: [{ content: "plan item", status: "in_progress" }],
			})

			// Only 3 turns — below threshold
			for (let i = 0; i < 3; i++) bumpStallCounter()

			const md = __test_renderTodoStateMarkdown()
			expect(md).not.toContain("\u26a0 Step todos have not been updated")
		} finally {
			unsubscribe()
		}
	})

	it("stall counter returns 0 when no step is running", () => {
		// No step started — bumping should have no effect
		bumpStallCounter()
		bumpStallCounter()
		expect(getTurnsSinceStepTodoWrite()).toBe(0)
	})
})

describe("parallel step tracking", () => {
	beforeEach(() => {
		__resetTodoStore()
		setActive(undefined)
		setCurrentSessionHasUI(false)
	})

	afterEach(() => {
		setActive(undefined)
		__resetTodoStore()
		setCurrentSessionHasUI(true)
	})

	function makeParallelFerment(): Ferment {
		return {
			id: "f-parallel",
			name: "Parallel Test",
			status: "running",
			worktree: { path: "/tmp" },
			scoping: {},
			phases: [
				{
					id: "phase-1",
					index: 1,
					name: "Parallel",
					goal: "do things",
					status: "active",
					steps: [
						{ id: "step-a", index: 1, description: "Branch A", status: "running", parallel: true, groupIndex: 1 },
						{ id: "step-b", index: 2, description: "Branch B", status: "running", parallel: true, groupIndex: 1 },
					],
				},
			],
			decisions: [],
			memories: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}
	}

	it("tracks multiple parallel steps independently", () => {
		const ferment = makeParallelFerment()
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-a" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-b" }, ferment)

			const running = __getRunningSteps()
			expect(running.size).toBe(2)
			expect(running.has("phase-1/step-a")).toBe(true)
			expect(running.has("phase-1/step-b")).toBe(true)
		} finally {
			unsubscribe()
		}
	})

	it("completing one parallel step leaves the other running", () => {
		const ferment = makeParallelFerment()
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-a" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-b" }, ferment)

			// Complete step-a only
			emitFermentDomainEvent(pi.events, { type: "complete_step", phaseId: "phase-1", stepId: "step-a" }, ferment)

			const running = __getRunningSteps()
			expect(running.size).toBe(1)
			expect(running.has("phase-1/step-a")).toBe(false)
			expect(running.has("phase-1/step-b")).toBe(true)
		} finally {
			unsubscribe()
		}
	})

	it("scope provider returns undefined when multiple steps are active", () => {
		const ferment = makeParallelFerment()
		setActive(ferment)
		const { pi, unsubscribe } = makePiWithRealEventBus()

		try {
			emitFermentDomainEvent(pi.events, { type: "activate_phase", phaseId: "phase-1" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-a" }, ferment)
			emitFermentDomainEvent(pi.events, { type: "start_step", phaseId: "phase-1", stepId: "step-b" }, ferment)

			// With two parallel steps active, auto-scope should refuse to guess.
			expect(resolveTodoScope()).toEqual({ kind: "global" })
		} finally {
			unsubscribe()
		}
	})
})
