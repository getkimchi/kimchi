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
import { __resetTodoStore, getTodosForScope } from "../todos/store.js"
import { emitFermentDomainEvent } from "./domain-events-emitter.js"
import { setActive } from "./state.js"
import { registerFermentTodoSync } from "./todo-sync.js"

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
