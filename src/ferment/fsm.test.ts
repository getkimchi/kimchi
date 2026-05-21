/**
 * FSM Tests — Finite State Machine for Ferment System
 */

import { describe, expect, it } from "vitest"
import {
	FSM_EVENTS,
	FSM_STATES,
	type FermentFsmContext,
	fermentStatusToFsmState,
	fsmStateToFermentStatus,
	getValidEvents,
	isTerminalState,
	transition,
} from "./fsm.js"

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<FermentFsmContext> = {}): FermentFsmContext {
	return {
		fermentStatus: "draft",
		phases: [],
		...overrides,
	}
}

function makePhaseContext(
	id: string,
	index: number,
	status: FermentFsmContext["phases"][number]["status"],
	steps: FermentFsmContext["phases"][number]["steps"] = [],
	groupIndex?: number,
): FermentFsmContext["phases"][number] {
	return { id, index, name: `Phase ${index}`, status, steps, groupIndex }
}

function makeStepContext(
	id: string,
	index: number,
	status: FermentFsmContext["phases"][number]["steps"][number]["status"],
	parallel = false,
	groupIndex?: number,
): FermentFsmContext["phases"][number]["steps"][number] {
	return { id, index, description: `Step ${index}`, status, parallel, groupIndex }
}

// ─── FSM State Mapping Tests ──────────────────────────────────────────────────

describe("fermentStatusToFsmState", () => {
	it("maps draft to DRAFT", () => {
		expect(fermentStatusToFsmState("draft")).toBe(FSM_STATES.DRAFT)
	})

	it("maps planned to PLANNED", () => {
		expect(fermentStatusToFsmState("planned")).toBe(FSM_STATES.PLANNED)
	})

	it("maps running to PHASE_ACTIVE", () => {
		expect(fermentStatusToFsmState("running")).toBe(FSM_STATES.PHASE_ACTIVE)
	})

	it("maps paused to PAUSED", () => {
		expect(fermentStatusToFsmState("paused")).toBe(FSM_STATES.PAUSED)
	})

	it("maps complete to COMPLETE", () => {
		expect(fermentStatusToFsmState("complete")).toBe(FSM_STATES.COMPLETE)
	})

	it("maps abandoned to ABANDONED", () => {
		expect(fermentStatusToFsmState("abandoned")).toBe(FSM_STATES.ABANDONED)
	})
})

describe("fsmStateToFermentStatus", () => {
	it("maps DRAFT back to planned", () => {
		expect(fsmStateToFermentStatus(FSM_STATES.DRAFT)).toBe("planned")
	})

	it("maps PHASE_ACTIVE back to running", () => {
		expect(fsmStateToFermentStatus(FSM_STATES.PHASE_ACTIVE)).toBe("running")
	})

	it("maps COMPLETE back to complete", () => {
		expect(fsmStateToFermentStatus(FSM_STATES.COMPLETE)).toBe("complete")
	})
})

// ─── Valid Transitions ────────────────────────────────────────────────────────

describe("Valid Transitions", () => {
	describe("DRAFT state", () => {
		it("handles SCOPE_FERMENT → PLANNED when phases exist", () => {
			const ctx = makeContext({
				phases: [makePhaseContext("phase-1", 1, "planned")],
			})
			const result = transition(FSM_STATES.DRAFT, FSM_EVENTS.SCOPE_FERMENT, ctx)
			expect(result.state).toBe(FSM_STATES.PLANNED)
			expect(result.error).toBeUndefined()
		})

		it("handles ABANDON → ABANDONED", () => {
			const ctx = makeContext()
			const result = transition(FSM_STATES.DRAFT, FSM_EVENTS.ABANDON, ctx)
			expect(result.state).toBe(FSM_STATES.ABANDONED)
			expect(result.error).toBeUndefined()
		})
	})

	describe("PLANNED state", () => {
		it("handles ACTIVATE_PHASE → PHASE_ACTIVE", () => {
			const ctx = makeContext({
				fermentStatus: "planned",
				phases: [makePhaseContext("phase-1", 1, "planned")],
			})
			const result = transition(FSM_STATES.PLANNED, FSM_EVENTS.ACTIVATE_PHASE, ctx, {
				phaseId: "phase-1",
			})
			expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
			expect(result.error).toBeUndefined()
		})

		it("transitions cleanly when activating a planned phase", () => {
			const ctx = makeContext({
				fermentStatus: "planned",
				phases: [makePhaseContext("phase-1", 1, "planned")],
			})
			const result = transition(FSM_STATES.PLANNED, FSM_EVENTS.ACTIVATE_PHASE, ctx, {
				phaseId: "phase-1",
			})
			expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
			expect(result.error).toBeUndefined()
		})

		it("handles ACTIVATE_PHASE for a failed phase", () => {
			const ctx = makeContext({
				fermentStatus: "planned",
				phases: [makePhaseContext("phase-1", 1, "failed")],
			})
			const result = transition(FSM_STATES.PLANNED, FSM_EVENTS.ACTIVATE_PHASE, ctx, {
				phaseId: "phase-1",
			})
			expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
			expect(result.error).toBeUndefined()
		})
	})

	describe("PHASE_ACTIVE state", () => {
		it("handles START_STEP → STEP_RUNNING", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [makePhaseContext("phase-1", 1, "active", [makeStepContext("step-1", 1, "pending")])],
			})
			const result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.START_STEP, ctx, {
				phaseId: "phase-1",
				stepId: "step-1",
			})
			expect(result.state).toBe(FSM_STATES.STEP_RUNNING)
			expect(result.error).toBeUndefined()
		})

		it("handles PAUSE → PAUSED", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [makePhaseContext("phase-1", 1, "active")],
			})
			const result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.PAUSE, ctx)
			expect(result.state).toBe(FSM_STATES.PAUSED)
			expect(result.error).toBeUndefined()
		})

		it("handles ABANDON → ABANDONED", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [makePhaseContext("phase-1", 1, "active")],
			})
			const result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.ABANDON, ctx)
			expect(result.state).toBe(FSM_STATES.ABANDONED)
			expect(result.error).toBeUndefined()
		})
	})

	describe("STEP_RUNNING state", () => {
		it("handles COMPLETE_STEP → PHASE_ACTIVE", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [makePhaseContext("phase-1", 1, "active", [makeStepContext("step-1", 1, "running")])],
			})
			const result = transition(FSM_STATES.STEP_RUNNING, FSM_EVENTS.COMPLETE_STEP, ctx, {
				phaseId: "phase-1",
				stepId: "step-1",
			})
			expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
			expect(result.error).toBeUndefined()
		})

		it("handles FAIL_STEP → PHASE_ACTIVE", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [makePhaseContext("phase-1", 1, "active", [makeStepContext("step-1", 1, "running")])],
			})
			const result = transition(FSM_STATES.STEP_RUNNING, FSM_EVENTS.FAIL_STEP, ctx, {
				phaseId: "phase-1",
				stepId: "step-1",
			})
			expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
			expect(result.error).toBeUndefined()
		})

		it("handles SKIP_STEP → PHASE_ACTIVE", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [makePhaseContext("phase-1", 1, "active", [makeStepContext("step-1", 1, "running")])],
			})
			const result = transition(FSM_STATES.STEP_RUNNING, FSM_EVENTS.SKIP_STEP, ctx, {
				phaseId: "phase-1",
				stepId: "step-1",
			})
			expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
			expect(result.error).toBeUndefined()
		})
	})

	describe("PAUSED state", () => {
		it("handles RESUME → PHASE_ACTIVE when phase is active", () => {
			const ctx = makeContext({
				fermentStatus: "paused",
				activePhaseId: "phase-1",
				phases: [makePhaseContext("phase-1", 1, "active")],
			})
			const result = transition(FSM_STATES.PAUSED, FSM_EVENTS.RESUME, ctx, {
				phaseId: "phase-1",
			})
			expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
			expect(result.error).toBeUndefined()
		})

		it("handles RESUME → PLANNED when resuming between phases", () => {
			const ctx = makeContext({
				fermentStatus: "paused",
				phases: [makePhaseContext("phase-1", 1, "planned")],
			})
			const result = transition(FSM_STATES.PAUSED, FSM_EVENTS.RESUME, ctx)
			expect(result.state).toBe(FSM_STATES.PLANNED)
			expect(result.error).toBeUndefined()
		})
	})

	describe("COMPLETE state", () => {
		it("handles ABANDON from COMPLETE → ABANDONED", () => {
			const ctx = makeContext({ fermentStatus: "complete" })
			const result = transition(FSM_STATES.COMPLETE, FSM_EVENTS.ABANDON, ctx)
			expect(result.state).toBe(FSM_STATES.ABANDONED)
			expect(result.error).toBeUndefined()
		})
	})
})

// ─── Illegal Transitions (Guard Rejections) ───────────────────────────────────

describe("Illegal Transitions (Guards)", () => {
	describe("SCOPE_FERMENT in DRAFT", () => {
		// The previous `hasPhases` guard was wrong: scope is what *creates*
		// phases. Tool-layer code papered over it by skipping FSM validation
		// when status === "draft". The guard has been removed (§4.1 of the
		// review), so SCOPE_FERMENT on an empty DRAFT is legal — phases ride
		// in via the command, not as a precondition.
		it("accepts SCOPE_FERMENT in DRAFT even with no pre-existing phases", () => {
			const ctx = makeContext() // no phases
			const result = transition(FSM_STATES.DRAFT, FSM_EVENTS.SCOPE_FERMENT, ctx)
			expect(result.state).toBe(FSM_STATES.PLANNED)
			expect(result.error).toBeUndefined()
		})
	})

	describe("ACTIVATE_PHASE guards", () => {
		it("rejects ACTIVATE_PHASE for non-existent phase", () => {
			const ctx = makeContext({
				fermentStatus: "planned",
				phases: [],
			})
			const result = transition(FSM_STATES.PLANNED, FSM_EVENTS.ACTIVATE_PHASE, ctx, {
				phaseId: "non-existent",
			})
			expect(result.error).toBeDefined()
			expect(result.error).toContain("not found")
		})

		it("rejects ACTIVATE_PHASE for already active phase", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [makePhaseContext("phase-1", 1, "active")],
			})
			const result = transition(FSM_STATES.PLANNED, FSM_EVENTS.ACTIVATE_PHASE, ctx, {
				phaseId: "phase-1",
			})
			expect(result.error).toBeDefined()
			expect(result.error).toContain('expected "planned"')
		})

		it("accepts ACTIVATE_PHASE for failed phase", () => {
			const ctx = makeContext({
				fermentStatus: "planned",
				phases: [makePhaseContext("phase-1", 1, "failed")],
			})
			const result = transition(FSM_STATES.PLANNED, FSM_EVENTS.ACTIVATE_PHASE, ctx, {
				phaseId: "phase-1",
			})
			expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
			expect(result.error).toBeUndefined()
		})
	})

	describe("START_STEP guards", () => {
		it("rejects START_STEP when another non-parallel step is running", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [
					makePhaseContext("phase-1", 1, "active", [
						makeStepContext("step-1", 1, "running", false), // non-parallel
						makeStepContext("step-2", 2, "pending", false),
					]),
				],
			})
			const result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.START_STEP, ctx, {
				phaseId: "phase-1",
				stepId: "step-2",
			})
			expect(result.error).toBeDefined()
			expect(result.error).toContain("already running")
			expect(result.error).toContain("non-parallel")
		})

		it("allows START_STEP when both steps share a parallel group", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [
					makePhaseContext("phase-1", 1, "active", [
						makeStepContext("step-1", 1, "running", true, 1),
						makeStepContext("step-2", 2, "pending", true, 1),
					]),
				],
			})
			const result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.START_STEP, ctx, {
				phaseId: "phase-1",
				stepId: "step-2",
			})
			expect(result.state).toBe(FSM_STATES.STEP_RUNNING)
			expect(result.error).toBeUndefined()
		})

		it("rejects START_STEP when parallel steps are in different groups", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [
					makePhaseContext("phase-1", 1, "active", [
						makeStepContext("step-1", 1, "running", true, 1),
						makeStepContext("step-2", 2, "pending", true, 2),
					]),
				],
			})
			const result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.START_STEP, ctx, {
				phaseId: "phase-1",
				stepId: "step-2",
			})
			expect(result.error).toBeDefined()
			expect(result.error).toContain("already running")
		})
	})

	describe("COMPLETE_STEP guards", () => {
		it("rejects COMPLETE_STEP when step is not running", () => {
			const ctx = makeContext({
				fermentStatus: "running",
				activePhaseId: "phase-1",
				phases: [makePhaseContext("phase-1", 1, "active", [makeStepContext("step-1", 1, "pending")])],
			})
			const result = transition(FSM_STATES.STEP_RUNNING, FSM_EVENTS.COMPLETE_STEP, ctx, {
				phaseId: "phase-1",
				stepId: "step-1",
			})
			expect(result.error).toBeDefined()
			expect(result.error).toContain('expected "running"')
		})
	})

	describe("PAUSE guards", () => {
		it("rejects PAUSE in PLANNED state", () => {
			const ctx = makeContext({
				fermentStatus: "planned",
				phases: [makePhaseContext("phase-1", 1, "planned")],
			})
			const result = transition(FSM_STATES.PLANNED, FSM_EVENTS.PAUSE, ctx)
			expect(result.error).toBeDefined()
			expect(result.error).toContain("not valid in state")
		})
	})

	describe("RESUME guards", () => {
		it("allows RESUME when all phases are terminal so complete_ferment can run", () => {
			const ctx = makeContext({
				fermentStatus: "paused",
				phases: [makePhaseContext("phase-1", 1, "completed")], // all phases done
			})
			const result = transition(FSM_STATES.PAUSED, FSM_EVENTS.RESUME, ctx)
			expect(result.state).toBe(FSM_STATES.PLANNED)
			expect(result.error).toBeUndefined()
		})
	})

	describe("Event not valid in state", () => {
		it("rejects START_STEP in PLANNED state", () => {
			const ctx = makeContext({
				fermentStatus: "planned",
				phases: [makePhaseContext("phase-1", 1, "planned", [makeStepContext("step-1", 1, "pending")])],
			})
			const result = transition(FSM_STATES.PLANNED, FSM_EVENTS.START_STEP, ctx, {
				phaseId: "phase-1",
				stepId: "step-1",
			})
			expect(result.error).toBeDefined()
			expect(result.error).toContain("not valid in state")
		})
	})
})

// ─── Parallel Phase Group Transitions ─────────────────────────────────────────

describe("Parallel Phase Group Transitions", () => {
	it("blocks phase completion when phase is not active", () => {
		// ferment is running but the target phase is not the active one
		const ctx = makeContext({
			fermentStatus: "running",
			activePhaseId: "phase-2",
			phases: [makePhaseContext("phase-1", 1, "planned", [], 1), makePhaseContext("phase-2", 2, "active", [], 1)],
		})
		const result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.COMPLETE_PHASE, ctx, {
			phaseId: "phase-1",
		})
		expect(result.error).toBeDefined()
		expect(result.error).toContain("active")
	})

	it("settles to planned when the active phase is the last active parallel sibling", () => {
		const ctx = makeContext({
			fermentStatus: "running",
			activePhaseId: "phase-1",
			phases: [
				makePhaseContext("phase-1", 1, "active", [], 1),
				makePhaseContext("phase-2", 2, "skipped", [], 1), // same group, terminal
			],
		})
		const result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.SKIP_PHASE, ctx, {
			phaseId: "phase-1",
		})
		expect(result.error).toBeUndefined()
		expect(result.state).toBe(FSM_STATES.PLANNED)
	})

	it("stays phase-active when another parallel phase remains active", () => {
		const ctx = makeContext({
			fermentStatus: "running",
			activePhaseId: "phase-1",
			phases: [makePhaseContext("phase-1", 1, "active", [], 1), makePhaseContext("phase-2", 2, "active", [], 1)],
		})
		const result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.COMPLETE_PHASE, ctx, {
			phaseId: "phase-1",
		})
		expect(result.error).toBeUndefined()
		expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
	})
})

// ─── Pause/Resume Cycle ───────────────────────────────────────────────────────

describe("Pause/Resume Cycle", () => {
	it("full pause/resume cycle: DRAFT → PLANNED → PHASE_ACTIVE → PAUSED → RESUME", () => {
		// Step 1: Scope with phases. Draft creation is host-owned and does not
		// go through an agent-visible FSM event.
		let ctx = makeContext({ phases: [makePhaseContext("phase-1", 1, "planned")] })
		let result = transition(FSM_STATES.DRAFT, FSM_EVENTS.SCOPE_FERMENT, ctx)
		expect(result.state).toBe(FSM_STATES.PLANNED)

		// Step 2: Activate phase
		result = transition(FSM_STATES.PLANNED, FSM_EVENTS.ACTIVATE_PHASE, ctx, {
			phaseId: "phase-1",
		})
		expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)

		// Step 4: Pause
		ctx = makeContext({ activePhaseId: "phase-1", phases: [makePhaseContext("phase-1", 1, "active")] })
		result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.PAUSE, ctx)
		expect(result.state).toBe(FSM_STATES.PAUSED)

		// Step 5: Resume
		result = transition(FSM_STATES.PAUSED, FSM_EVENTS.RESUME, ctx, {
			phaseId: "phase-1",
		})
		expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
	})

	it("pause/resume preserves context correctly", () => {
		const ctx = makeContext({
			fermentStatus: "running",
			activePhaseId: "phase-1",
			phases: [
				makePhaseContext("phase-1", 1, "active", [
					makeStepContext("step-1", 1, "pending"),
					makeStepContext("step-2", 2, "pending"),
				]),
			],
		})

		// Pause
		const pauseResult = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.PAUSE, ctx)
		expect(pauseResult.state).toBe(FSM_STATES.PAUSED)

		// Resume
		const resumeResult = transition(FSM_STATES.PAUSED, FSM_EVENTS.RESUME, ctx, {
			phaseId: "phase-1",
		})
		expect(resumeResult.state).toBe(FSM_STATES.PHASE_ACTIVE)
		expect(resumeResult.error).toBeUndefined()
	})
})

// `nextAction` was deleted — see §4.1 of docs/ferment-review.md. The "what
// to do next" path lives in engine.determineNextAction (with its own tests in
// engine.test.ts). The FSM is a transition validator, not a planner.

// ─── Utility Functions ────────────────────────────────────────────────────────

describe("Utility Functions", () => {
	describe("isTerminalState", () => {
		it("returns true for COMPLETE", () => {
			expect(isTerminalState(FSM_STATES.COMPLETE)).toBe(true)
		})

		it("returns true for ABANDONED", () => {
			expect(isTerminalState(FSM_STATES.ABANDONED)).toBe(true)
		})

		it("returns false for non-terminal states", () => {
			expect(isTerminalState(FSM_STATES.DRAFT)).toBe(false)
			expect(isTerminalState(FSM_STATES.PLANNED)).toBe(false)
			expect(isTerminalState(FSM_STATES.PHASE_ACTIVE)).toBe(false)
			expect(isTerminalState(FSM_STATES.STEP_RUNNING)).toBe(false)
			expect(isTerminalState(FSM_STATES.PAUSED)).toBe(false)
		})
	})

	describe("getValidEvents", () => {
		it("returns valid events for DRAFT", () => {
			const events = getValidEvents(FSM_STATES.DRAFT)
			expect(events).toContain(FSM_EVENTS.SCOPE_FERMENT)
			expect(events).toContain(FSM_EVENTS.ABANDON)
			expect(events).not.toContain("set_mode")
		})

		it("returns valid events for PHASE_ACTIVE", () => {
			const events = getValidEvents(FSM_STATES.PHASE_ACTIVE)
			expect(events).toContain(FSM_EVENTS.START_STEP)
			expect(events).toContain(FSM_EVENTS.COMPLETE_PHASE)
			expect(events).toContain(FSM_EVENTS.PAUSE)
			expect(events).toContain(FSM_EVENTS.ABANDON)
		})

		it("returns empty array for ABANDONED (terminal state)", () => {
			const events = getValidEvents(FSM_STATES.ABANDONED)
			expect(events).toHaveLength(0)
		})
	})
})

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe("Edge Cases", () => {
	it("handles COMPLETE_PHASE when all phases are terminal → transitions to COMPLETE", () => {
		// Phase is already terminal (e.g. it was just completed); simulate a scored phase
		const completedPhase = makePhaseContext("phase-1", 1, "completed", [makeStepContext("step-1", 1, "done")])
		const ctx = makeContext({
			fermentStatus: "running",
			activePhaseId: "phase-1",
			phases: [completedPhase],
		})
		// Since the only phase is already terminal, FSM state is COMPLETE
		const result = transition(FSM_STATES.COMPLETE, FSM_EVENTS.COMPLETE_PHASE, ctx, {
			phaseId: "phase-1",
		})
		expect(result.error).toBeUndefined()
		expect(result.state).toBe(FSM_STATES.COMPLETE)
	})

	it("handles SKIP_PHASE with no remaining active phases → PLANNED", () => {
		const ctx = makeContext({
			fermentStatus: "running",
			activePhaseId: "phase-1",
			phases: [makePhaseContext("phase-1", 1, "active")],
		})
		const result = transition(FSM_STATES.PHASE_ACTIVE, FSM_EVENTS.SKIP_PHASE, ctx, {
			phaseId: "phase-1",
		})
		expect(result.state).toBe(FSM_STATES.PLANNED)
		expect(result.error).toBeUndefined()
	})

	it("handles VERIFY_STEP similar to COMPLETE_STEP", () => {
		const ctx = makeContext({
			fermentStatus: "running",
			activePhaseId: "phase-1",
			phases: [makePhaseContext("phase-1", 1, "active", [makeStepContext("step-1", 1, "running")])],
		})
		const result = transition(FSM_STATES.STEP_RUNNING, FSM_EVENTS.VERIFY_STEP, ctx, {
			phaseId: "phase-1",
			stepId: "step-1",
		})
		expect(result.state).toBe(FSM_STATES.PHASE_ACTIVE)
		expect(result.error).toBeUndefined()
	})
})
