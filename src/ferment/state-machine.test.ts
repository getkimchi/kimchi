/**
 * Pure transition tests for the ferment state machine.
 *
 * These tests are I/O-free and timestamp-deterministic — every test passes
 * a fixed `now` so output is byte-identical across runs. They exhaustively
 * cover the transition matrix (every command × relevant prerequisite states)
 * and codify error contracts (every error code is exercised at least once).
 */

import { describe, expect, it } from "vitest"
import { type Command, type TransitionContext, applyCommand } from "./state-machine.js"
import type { Ferment, JudgeGrade, Phase, Step, StepResult } from "./types.js"

const NOW = "2026-05-08T15:00:00.000Z"
const ctx: TransitionContext = { now: NOW }

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-1",
		name: "Test Ferment",
		status: "draft",
		worktree: { path: "/tmp/test" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		...overrides,
	}
}

function makeStep(overrides: Partial<Step> = {}): Step {
	return {
		id: "step-1",
		index: 1,
		description: "do thing",
		status: "pending",
		...overrides,
	}
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
	return {
		id: "phase-1",
		index: 1,
		name: "Phase 1",
		goal: "Build it",
		status: "planned",
		steps: [],
		...overrides,
	}
}

function makeGrade(grade: JudgeGrade["grade"] = "A"): JudgeGrade {
	return { grade, rationale: "reasoning", gradedAt: NOW }
}

// Asserts ok and unwraps; throws TS-typed error on failure.
function expectOk(r: ReturnType<typeof applyCommand>): Ferment {
	if (!r.ok) {
		throw new Error(`Expected ok, got error ${r.error.code}: ${r.error.message}`)
	}
	return r.ferment
}

function expectError(r: ReturnType<typeof applyCommand>): NonNullable<Extract<typeof r, { ok: false }>["error"]> {
	if (r.ok) throw new Error("Expected error, got ok")
	return r.error
}

// ─── scope ────────────────────────────────────────────────────────────────────

describe("applyCommand: scope", () => {
	it("transitions draft → planned with phases and steps", () => {
		const f = makeFerment()
		const result = expectOk(
			applyCommand(
				f,
				{
					type: "scope",
					goal: "Make a thing",
					successCriteria: ["It works"],
					constraints: ["no libs", "must be fast"],
					phases: [
						{
							name: "Phase A",
							goal: "Build A",
							steps: [{ description: "Step A1" }, { description: "Step A2", verify: "echo ok" }],
						},
						{ name: "Phase B", goal: "Build B", steps: [{ description: "Step B1" }] },
					],
				},
				ctx,
			),
		)

		expect(result.status).toBe("planned")
		expect(result.goal).toBe("Make a thing")
		expect(result.successCriteria).toEqual(["It works"])
		expect(result.constraints).toEqual(["no libs", "must be fast"])
		expect(result.scoping.goal?.answer).toBe("Make a thing")
		expect(result.scoping.criteria?.answer).toBe("It works")
		expect(result.scoping.constraints?.answer).toBe("no libs, must be fast")
		expect(result.scoping.phases?.answer).toBe("Phase A, Phase B")
		expect(result.phases).toHaveLength(2)
		expect(result.phases[0]).toMatchObject({
			id: "phase-1",
			index: 1,
			name: "Phase A",
			status: "planned",
		})
		expect(result.phases[0].steps).toHaveLength(2)
		expect(result.phases[0].steps[0]).toMatchObject({ id: "step-1", index: 1, status: "pending" })
		expect(result.phases[0].steps[1].verification?.command).toBe("echo ok")
		expect(result.updatedAt).toBe(NOW)
	})

	it("captures parallel_group on phases", () => {
		const result = expectOk(
			applyCommand(
				makeFerment(),
				{
					type: "scope",
					goal: "G",
					phases: [
						{ name: "P1", goal: "g1", parallel_group: 1, steps: [{ description: "s" }] },
						{ name: "P2", goal: "g2", parallel_group: 1, steps: [{ description: "s" }] },
						{ name: "P3", goal: "g3", steps: [{ description: "s" }] },
					],
				},
				ctx,
			),
		)
		expect(result.phases[0].groupIndex).toBe(1)
		expect(result.phases[0].parallel).toBe(true)
		expect(result.phases[2].groupIndex).toBeUndefined()
		expect(result.phases[2].parallel).toBe(false)
	})

	it("collapses a loner parallel_group (single phase) to sequential", () => {
		// A phase that's the only member of its group is functionally serial:
		// there's no cohort to activate together. The state-machine materialises
		// it as parallel=false / groupIndex=undefined so engine, events, and UI
		// don't misreport it as parallel.
		const result = expectOk(
			applyCommand(
				makeFerment(),
				{
					type: "scope",
					goal: "G",
					phases: [
						{ name: "P1", goal: "g1", parallel_group: 1, steps: [{ description: "s" }] },
						{ name: "P2", goal: "g2", parallel_group: 2, steps: [{ description: "s" }] },
						{ name: "P3", goal: "g3", parallel_group: 2, steps: [{ description: "s" }] },
					],
				},
				ctx,
			),
		)
		// P1 — loner group 1, collapsed
		expect(result.phases[0].parallel).toBe(false)
		expect(result.phases[0].groupIndex).toBeUndefined()
		// P2, P3 — real cohort group 2, preserved
		expect(result.phases[1].parallel).toBe(true)
		expect(result.phases[1].groupIndex).toBe(2)
		expect(result.phases[2].parallel).toBe(true)
		expect(result.phases[2].groupIndex).toBe(2)
	})

	it("renames the ferment when title is provided", () => {
		const result = expectOk(
			applyCommand(makeFerment({ name: "Original" }), { type: "scope", title: "Renamed", goal: "G", phases: [] }, ctx),
		)
		expect(result.name).toBe("Renamed")
	})

	it("rejects when ferment is not in draft", () => {
		const error = expectError(
			applyCommand(makeFerment({ status: "running" }), { type: "scope", goal: "G", phases: [] }, ctx),
		)
		expect(error.code).toBe("FERMENT_NOT_IN_STATUS")
		if (error.code === "FERMENT_NOT_IN_STATUS") {
			expect(error.actual).toBe("running")
			expect(error.expected).toEqual(["draft"])
		}
	})

	it("does not mutate the input ferment", () => {
		const f = makeFerment()
		applyCommand(f, { type: "scope", goal: "G", phases: [{ name: "P", goal: "g", steps: [] }] }, ctx)
		expect(f.status).toBe("draft")
		expect(f.phases).toEqual([])
	})

	it("scope command persists assumptions when provided", () => {
		const result = expectOk(
			applyCommand(
				makeFerment(),
				{
					type: "scope",
					goal: "g",
					successCriteria: ["sc"],
					constraints: ["c"],
					assumptions: "k8s cluster exists",
					phases: [{ name: "P1", goal: "g1", steps: [{ description: "s1" }] }],
				},
				ctx,
			),
		)
		expect(result.scoping.assumptions?.answer).toBe("k8s cluster exists")
		expect(result.scoping.assumptions?.confirmedAt).toBe(NOW)
	})

	it("scope command omits assumptions when not provided", () => {
		const result = expectOk(
			applyCommand(
				makeFerment(),
				{
					type: "scope",
					goal: "g",
					phases: [{ name: "P1", goal: "g1", steps: [{ description: "s1" }] }],
				},
				ctx,
			),
		)
		expect(result.scoping.assumptions).toBeUndefined()
	})

	it("scope command omits assumptions when empty string", () => {
		const result = expectOk(
			applyCommand(
				makeFerment(),
				{
					type: "scope",
					goal: "g",
					assumptions: "",
					phases: [{ name: "P1", goal: "g1", steps: [{ description: "s1" }] }],
				},
				ctx,
			),
		)
		expect(result.scoping.assumptions).toBeUndefined()
	})
})

// ─── update_scope_field ───────────────────────────────────────────────────────

describe("applyCommand: update_scope_field", () => {
	it("updates goal", () => {
		const result = expectOk(
			applyCommand(
				makeFerment({ status: "planned" }),
				{ type: "update_scope_field", field: "goal", value: "New goal" },
				ctx,
			),
		)
		expect(result.goal).toBe("New goal")
		expect(result.scoping.goal?.answer).toBe("New goal")
	})

	it("updates criteria", () => {
		const result = expectOk(
			applyCommand(makeFerment(), { type: "update_scope_field", field: "criteria", value: "passes" }, ctx),
		)
		expect(result.successCriteria).toEqual(["passes"])
	})

	it("updates criteria from newline-separated editor text", () => {
		const result = expectOk(
			applyCommand(
				makeFerment(),
				{ type: "update_scope_field", field: "criteria", value: "criterion A\ncriterion B\ncriterion C" },
				ctx,
			),
		)
		expect(result.successCriteria).toEqual(["criterion A", "criterion B", "criterion C"])
		expect(result.scoping.criteria?.answer).toBe("criterion A\ncriterion B\ncriterion C")
	})

	it("updates constraints (parses comma-separated)", () => {
		const result = expectOk(
			applyCommand(makeFerment(), { type: "update_scope_field", field: "constraints", value: " a , b , c " }, ctx),
		)
		expect(result.constraints).toEqual(["a", "b", "c"])
	})

	it("rejects unknown field", () => {
		const error = expectError(
			applyCommand(
				makeFerment(),
				// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
				{ type: "update_scope_field", field: "bogus" as any, value: "x" },
				ctx,
			),
		)
		expect(error.code).toBe("INVALID_FIELD")
	})

	it("update_scope_field assumptions writes scoping.assumptions", () => {
		// First scope the ferment so it is in "planned" state with no assumptions,
		// then apply update_scope_field to write assumptions.
		const scoped = expectOk(
			applyCommand(
				makeFerment(),
				{
					type: "scope",
					goal: "g",
					phases: [{ name: "P1", goal: "g1", steps: [{ description: "s1" }] }],
				},
				ctx,
			),
		)
		const result = expectOk(
			applyCommand(scoped, { type: "update_scope_field", field: "assumptions", value: "new assumption" }, ctx),
		)
		expect(result.scoping.assumptions?.answer).toBe("new assumption")
		expect(result.scoping.assumptions?.confirmedAt).toBe(NOW)
	})
})

// ─── activate_phase ───────────────────────────────────────────────────────────

describe("applyCommand: activate_phase", () => {
	it("activates a planned phase", () => {
		const f = makeFerment({
			status: "planned",
			phases: [makePhase({ id: "phase-1", status: "planned" })],
		})
		const result = expectOk(applyCommand(f, { type: "activate_phase", phaseId: "phase-1" }, ctx))
		expect(result.status).toBe("running")
		expect(result.phases[0].status).toBe("active")
		expect(result.phases[0].startedAt).toBe(NOW)
		expect(result.activePhaseId).toBe("phase-1")
		expect(result.lastActiveAt).toBe(NOW)
	})

	it("deactivates the previously-active phase", () => {
		const f = makeFerment({
			status: "running",
			phases: [
				makePhase({ id: "phase-1", status: "active" }),
				makePhase({ id: "phase-2", status: "planned", index: 2, name: "P2" }),
			],
			activePhaseId: "phase-1",
		})
		const result = expectOk(applyCommand(f, { type: "activate_phase", phaseId: "phase-2" }, ctx))
		expect(result.phases[0].status).toBe("planned")
		expect(result.phases[1].status).toBe("active")
		expect(result.activePhaseId).toBe("phase-2")
	})

	it("rejects when phase is not in planned or failed status", () => {
		const f = makeFerment({
			phases: [makePhase({ id: "phase-1", status: "completed" })],
		})
		const error = expectError(applyCommand(f, { type: "activate_phase", phaseId: "phase-1" }, ctx))
		expect(error.code).toBe("PHASE_NOT_IN_STATUS")
		if (error.code === "PHASE_NOT_IN_STATUS") {
			expect(error.expected).toEqual(["planned", "failed"])
			expect(error.actual).toBe("completed")
		}
	})

	it("reactivates a failed phase and clears stale terminal metadata", () => {
		const f = makeFerment({
			status: "planned",
			phases: [
				makePhase({
					id: "phase-1",
					status: "failed",
					summary: "failed before",
					completedAt: "2024-01-01T00:00:00.000Z",
					grade: makeGrade("F"),
				}),
			],
		})
		const result = expectOk(applyCommand(f, { type: "activate_phase", phaseId: "phase-1" }, ctx))
		expect(result.status).toBe("running")
		expect(result.phases[0].status).toBe("active")
		expect(result.phases[0].completedAt).toBeUndefined()
		expect(result.phases[0].summary).toBeUndefined()
		expect(result.phases[0].grade).toBeUndefined()
	})

	it("rejects when phase not found", () => {
		const error = expectError(applyCommand(makeFerment(), { type: "activate_phase", phaseId: "nope" }, ctx))
		expect(error.code).toBe("PHASE_NOT_FOUND")
	})
})

// ─── activate_phase_group ─────────────────────────────────────────────────────

describe("applyCommand: activate_phase_group", () => {
	it("activates all planned phases in the group", () => {
		const f = makeFerment({
			status: "planned",
			phases: [
				makePhase({ id: "phase-1", status: "planned", groupIndex: 1 }),
				makePhase({ id: "phase-2", status: "planned", groupIndex: 1, index: 2, name: "P2" }),
				makePhase({ id: "phase-3", status: "planned", index: 3, name: "P3" }),
			],
		})
		const result = expectOk(applyCommand(f, { type: "activate_phase_group", groupIndex: 1 }, ctx))
		expect(result.phases[0].status).toBe("active")
		expect(result.phases[1].status).toBe("active")
		expect(result.phases[2].status).toBe("planned") // not in group
		expect(result.activePhaseId).toBe("phase-1") // first in group
	})

	it("rejects when no planned phases in group", () => {
		const f = makeFerment({
			phases: [makePhase({ id: "phase-1", status: "completed", groupIndex: 1 })],
		})
		const error = expectError(applyCommand(f, { type: "activate_phase_group", groupIndex: 1 }, ctx))
		expect(error.code).toBe("PHASE_GROUP_EMPTY")
	})

	// Audit doc finding #1: handleActivatePhaseGroup used to leave a previously-
	// active non-group phase active alongside the new group, breaking the
	// "active phases are exactly the target group" invariant.
	it("deactivates a previously-active non-group phase (audit #1)", () => {
		const f = makeFerment({
			status: "running",
			activePhaseId: "phase-3",
			phases: [
				makePhase({ id: "phase-1", status: "planned", groupIndex: 1 }),
				makePhase({ id: "phase-2", status: "planned", groupIndex: 1, index: 2, name: "P2" }),
				// Already-active non-group phase that should get demoted on group activation.
				makePhase({ id: "phase-3", status: "active", index: 3, name: "P3" }),
			],
		})
		const result = expectOk(applyCommand(f, { type: "activate_phase_group", groupIndex: 1 }, ctx))
		expect(result.phases[0].status).toBe("active")
		expect(result.phases[1].status).toBe("active")
		// The previously-active P3 must be demoted to planned — not left active.
		expect(result.phases[2].status).toBe("planned")
		expect(result.activePhaseId).toBe("phase-1")
	})
})

// ─── refine_phase ─────────────────────────────────────────────────────────────

describe("applyCommand: refine_phase", () => {
	it("replaces steps on an active phase", () => {
		const f = makeFerment({
			phases: [makePhase({ id: "phase-1", status: "active" })],
		})
		const result = expectOk(
			applyCommand(
				f,
				{
					type: "refine_phase",
					phaseId: "phase-1",
					steps: [
						{ description: "first" },
						{ description: "second", verify: "test", parallel_group: 1 },
						{ description: "third", parallel_group: 1 },
					],
				},
				ctx,
			),
		)
		expect(result.phases[0].steps).toHaveLength(3)
		expect(result.phases[0].steps[0]).toMatchObject({ id: "step-1", index: 1, status: "pending" })
		expect(result.phases[0].steps[1]).toMatchObject({
			id: "step-2",
			index: 2,
			parallel: true,
			groupIndex: 1,
		})
		expect(result.phases[0].steps[2]).toMatchObject({
			id: "step-3",
			index: 3,
			parallel: true,
			groupIndex: 1,
		})
		expect(result.phases[0].steps[1].verification?.command).toBe("test")
	})

	it("collapses a singleton parallel_group step to sequential", () => {
		const f = makeFerment({ phases: [makePhase({ status: "active" })] })
		const result = expectOk(
			applyCommand(
				f,
				{
					type: "refine_phase",
					phaseId: "phase-1",
					steps: [{ description: "lone", parallel_group: 1 }],
				},
				ctx,
			),
		)
		expect(result.phases[0].steps[0]).toMatchObject({ parallel: false })
		expect(result.phases[0].steps[0].groupIndex).toBeUndefined()
	})

	it("rejects when phase is not active", () => {
		const f = makeFerment({ phases: [makePhase({ status: "planned" })] })
		const error = expectError(
			applyCommand(f, { type: "refine_phase", phaseId: "phase-1", steps: [{ description: "x" }] }, ctx),
		)
		expect(error.code).toBe("PHASE_NOT_IN_STATUS")
	})

	// Audit doc finding #4 — refine_phase used to silently destroy a running
	// step by overwriting the entire steps array. The guard now rejects.
	it("rejects when a step is running (audit #4)", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					status: "active",
					steps: [makeStep({ id: "step-1", status: "running", description: "in flight" })],
				}),
			],
		})
		const error = expectError(
			applyCommand(f, { type: "refine_phase", phaseId: "phase-1", steps: [{ description: "x" }] }, ctx),
		)
		expect(error.code).toBe("STEP_RUNNING")
		if (error.code === "STEP_RUNNING") {
			expect(error.runningStepId).toBe("step-1")
			expect(error.runningStepIndex).toBe(1)
			expect(error.runningDescription).toBe("in flight")
			expect(error.message).toContain("currently running")
		}
	})

	it("allows refine after the running step transitions to a terminal state", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					status: "active",
					steps: [makeStep({ id: "step-1", status: "done" })],
				}),
			],
		})
		const result = expectOk(
			applyCommand(f, { type: "refine_phase", phaseId: "phase-1", steps: [{ description: "fresh" }] }, ctx),
		)
		expect(result.phases[0].steps).toHaveLength(1)
		expect(result.phases[0].steps[0].description).toBe("fresh")
	})

	it("allows refine when other steps are pending or terminal but none running", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					status: "active",
					steps: [
						makeStep({ id: "step-1", status: "done" }),
						makeStep({ id: "step-2", status: "skipped" }),
						makeStep({ id: "step-3", status: "pending" }),
					],
				}),
			],
		})
		const result = expectOk(
			applyCommand(f, { type: "refine_phase", phaseId: "phase-1", steps: [{ description: "x" }] }, ctx),
		)
		expect(result.phases[0].steps).toHaveLength(1)
	})
})

// ─── start_step ───────────────────────────────────────────────────────────────

describe("applyCommand: start_step", () => {
	it("transitions step pending → running", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep()] })],
		})
		const result = expectOk(applyCommand(f, { type: "start_step", phaseId: "phase-1", stepId: "step-1" }, ctx))
		expect(result.phases[0].steps[0].status).toBe("running")
		expect(result.phases[0].steps[0].startedAt).toBe(NOW)
	})

	it("rejects when another non-parallel step is running", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					status: "active",
					steps: [
						makeStep({ id: "step-1", status: "running", parallel: false }),
						makeStep({ id: "step-2", index: 2, status: "pending", parallel: false }),
					],
				}),
			],
		})
		const error = expectError(applyCommand(f, { type: "start_step", phaseId: "phase-1", stepId: "step-2" }, ctx))
		expect(error.code).toBe("CONCURRENT_NON_PARALLEL_STEP")
		if (error.code === "CONCURRENT_NON_PARALLEL_STEP") {
			expect(error.runningStepId).toBe("step-1")
		}
	})

	it("allows starting a step in the same parallel group as a running step", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					status: "active",
					steps: [
						makeStep({ id: "step-1", status: "running", parallel: true, groupIndex: 1 }),
						makeStep({ id: "step-2", index: 2, status: "pending", parallel: true, groupIndex: 1 }),
					],
				}),
			],
		})
		const result = expectOk(applyCommand(f, { type: "start_step", phaseId: "phase-1", stepId: "step-2" }, ctx))
		expect(result.phases[0].steps[1].status).toBe("running")
	})

	it("rejects starting a parallel step in a different group than the running one", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					status: "active",
					steps: [
						makeStep({ id: "step-1", status: "running", parallel: true, groupIndex: 1 }),
						makeStep({ id: "step-2", index: 2, status: "pending", parallel: true, groupIndex: 2 }),
					],
				}),
			],
		})
		const error = expectError(applyCommand(f, { type: "start_step", phaseId: "phase-1", stepId: "step-2" }, ctx))
		expect(error.code).toBe("CONCURRENT_NON_PARALLEL_STEP")
	})

	it("rejects unknown step", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep()] })],
		})
		const error = expectError(applyCommand(f, { type: "start_step", phaseId: "phase-1", stepId: "step-99" }, ctx))
		expect(error.code).toBe("STEP_NOT_FOUND")
	})

	it("rejects unknown phase", () => {
		const error = expectError(
			applyCommand(makeFerment(), { type: "start_step", phaseId: "nope", stepId: "step-1" }, ctx),
		)
		expect(error.code).toBe("PHASE_NOT_FOUND")
	})
})

// ─── complete_step ────────────────────────────────────────────────────────────

describe("applyCommand: complete_step", () => {
	it("transitions running → done when no result", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "running" })] })],
		})
		const result = expectOk(applyCommand(f, { type: "complete_step", phaseId: "phase-1", stepId: "step-1" }, ctx))
		expect(result.phases[0].steps[0].status).toBe("done")
		expect(result.phases[0].steps[0].completedAt).toBe(NOW)
	})

	it("transitions running → verified when result.success is true", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "running" })] })],
		})
		const stepResult: StepResult = { success: true, exitCode: 0, completedAt: NOW }
		const result = expectOk(
			applyCommand(f, { type: "complete_step", phaseId: "phase-1", stepId: "step-1", result: stepResult }, ctx),
		)
		expect(result.phases[0].steps[0].status).toBe("verified")
		expect(result.phases[0].steps[0].result?.success).toBe(true)
	})

	it("attaches grade when provided", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "running" })] })],
		})
		const grade = makeGrade("A")
		const result = expectOk(
			applyCommand(f, { type: "complete_step", phaseId: "phase-1", stepId: "step-1", grade }, ctx),
		)
		expect(result.phases[0].steps[0].grade).toEqual(grade)
	})
})

// ─── verify_step ──────────────────────────────────────────────────────────────

describe("applyCommand: verify_step", () => {
	it("records result and sets verified status when success", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "running" })] })],
		})
		const stepResult: StepResult = { success: true, exitCode: 0, stdout: "ok", completedAt: NOW }
		const result = expectOk(
			applyCommand(f, { type: "verify_step", phaseId: "phase-1", stepId: "step-1", result: stepResult }, ctx),
		)
		expect(result.phases[0].steps[0].status).toBe("verified")
		expect(result.phases[0].steps[0].result?.stdout).toBe("ok")
	})

	it("sets done status when verify fails", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "running" })] })],
		})
		const stepResult: StepResult = { success: false, exitCode: 1, stderr: "fail", completedAt: NOW }
		const result = expectOk(
			applyCommand(f, { type: "verify_step", phaseId: "phase-1", stepId: "step-1", result: stepResult }, ctx),
		)
		expect(result.phases[0].steps[0].status).toBe("done")
	})
})

// ─── skip_step ────────────────────────────────────────────────────────────────

describe("applyCommand: skip_step", () => {
	it("transitions to skipped from any status", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "running" })] })],
		})
		const result = expectOk(applyCommand(f, { type: "skip_step", phaseId: "phase-1", stepId: "step-1" }, ctx))
		expect(result.phases[0].steps[0].status).toBe("skipped")
		expect(result.phases[0].steps[0].completedAt).toBe(NOW)
	})
})

// ─── fail_step ────────────────────────────────────────────────────────────────

describe("applyCommand: fail_step", () => {
	it("marks step failed with error message", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "running" })] })],
		})
		const result = expectOk(
			applyCommand(f, { type: "fail_step", phaseId: "phase-1", stepId: "step-1", error: "broke" }, ctx),
		)
		expect(result.phases[0].steps[0].status).toBe("failed")
		expect(result.phases[0].steps[0].result?.stderr).toBe("broke")
		expect(result.phases[0].steps[0].result?.success).toBe(false)
	})

	it("works without error message", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "running" })] })],
		})
		const result = expectOk(applyCommand(f, { type: "fail_step", phaseId: "phase-1", stepId: "step-1" }, ctx))
		expect(result.phases[0].steps[0].status).toBe("failed")
		expect(result.phases[0].steps[0].result).toBeUndefined()
	})
})

// ─── complete_phase ───────────────────────────────────────────────────────────

describe("applyCommand: complete_phase", () => {
	it("transitions active → completed", () => {
		const f = makeFerment({
			status: "running",
			activePhaseId: "phase-1",
			phases: [makePhase({ status: "active" })],
		})
		const result = expectOk(applyCommand(f, { type: "complete_phase", phaseId: "phase-1", summary: "done" }, ctx))
		expect(result.status).toBe("planned")
		expect(result.activePhaseId).toBeUndefined()
		expect(result.phases[0].status).toBe("completed")
		expect(result.phases[0].summary).toBe("done")
		expect(result.phases[0].completedAt).toBe(NOW)
	})

	it("clears the completed active phase so the next planned phase can activate", () => {
		const f = makeFerment({
			status: "running",
			activePhaseId: "phase-1",
			phases: [
				makePhase({ id: "phase-1", status: "active" }),
				makePhase({ id: "phase-2", index: 2, name: "P2", status: "planned" }),
			],
		})

		const completed = expectOk(applyCommand(f, { type: "complete_phase", phaseId: "phase-1", summary: "done" }, ctx))
		expect(completed.status).toBe("planned")
		expect(completed.activePhaseId).toBeUndefined()
		expect(completed.phases[0].status).toBe("completed")

		const activated = expectOk(applyCommand(completed, { type: "activate_phase", phaseId: "phase-2" }, ctx))
		expect(activated.status).toBe("running")
		expect(activated.activePhaseId).toBe("phase-2")
		expect(activated.phases[1].status).toBe("active")
	})

	it("keeps running and selects another active phase when completing one parallel phase", () => {
		const f = makeFerment({
			status: "running",
			activePhaseId: "phase-1",
			phases: [
				makePhase({ id: "phase-1", status: "active", groupIndex: 1 }),
				makePhase({ id: "phase-2", index: 2, name: "P2", status: "active", groupIndex: 1 }),
			],
		})

		const result = expectOk(applyCommand(f, { type: "complete_phase", phaseId: "phase-1", summary: "done" }, ctx))
		expect(result.status).toBe("running")
		expect(result.activePhaseId).toBe("phase-2")
		expect(result.phases[0].status).toBe("completed")
		expect(result.phases[1].status).toBe("active")
	})

	it("attaches grade when provided", () => {
		const f = makeFerment({ phases: [makePhase({ status: "active" })] })
		const grade = makeGrade("A")
		const result = expectOk(
			applyCommand(f, { type: "complete_phase", phaseId: "phase-1", summary: "done", grade }, ctx),
		)
		expect(result.phases[0].grade).toEqual(grade)
	})

	it("rejects when phase not active", () => {
		const f = makeFerment({ phases: [makePhase({ status: "planned" })] })
		const error = expectError(applyCommand(f, { type: "complete_phase", phaseId: "phase-1", summary: "x" }, ctx))
		expect(error.code).toBe("PHASE_NOT_IN_STATUS")
	})

	it("clears active phase state so the next planned phase can be activated", () => {
		const f = makeFerment({
			status: "running",
			activePhaseId: "phase-1",
			phases: [
				makePhase({ id: "phase-1", index: 1, name: "Phase 1", status: "active" }),
				makePhase({ id: "phase-2", index: 2, name: "Phase 2", status: "planned" }),
			],
		})

		const completed = expectOk(applyCommand(f, { type: "complete_phase", phaseId: "phase-1", summary: "done" }, ctx))
		expect(completed.phases[0].status).toBe("completed")
		expect(completed.status).toBe("planned")
		expect(completed.activePhaseId).toBeUndefined()

		const activated = expectOk(applyCommand(completed, { type: "activate_phase", phaseId: "phase-2" }, ctx))
		expect(activated.status).toBe("running")
		expect(activated.activePhaseId).toBe("phase-2")
		expect(activated.phases[1].status).toBe("active")
	})
})

// ─── skip_phase ───────────────────────────────────────────────────────────────

describe("applyCommand: skip_phase", () => {
	it("transitions to skipped with reason", () => {
		const f = makeFerment({ phases: [makePhase({ status: "planned" })] })
		const result = expectOk(applyCommand(f, { type: "skip_phase", phaseId: "phase-1", reason: "n/a" }, ctx))
		expect(result.phases[0].status).toBe("skipped")
		expect(result.phases[0].summary).toBe("n/a")
	})

	it("uses default reason when not provided", () => {
		const f = makeFerment({ phases: [makePhase({ status: "planned" })] })
		const result = expectOk(applyCommand(f, { type: "skip_phase", phaseId: "phase-1" }, ctx))
		expect(result.phases[0].summary).toBe("Skipped")
	})

	it("clears active phase metadata when skipping the active phase", () => {
		const f = makeFerment({
			status: "running",
			activePhaseId: "phase-1",
			phases: [makePhase({ status: "active" })],
		})
		const result = expectOk(applyCommand(f, { type: "skip_phase", phaseId: "phase-1" }, ctx))
		expect(result.status).toBe("planned")
		expect(result.activePhaseId).toBeUndefined()
		expect(result.phases[0].status).toBe("skipped")
	})
})

// ─── fail_phase ───────────────────────────────────────────────────────────────

describe("applyCommand: fail_phase", () => {
	it("transitions to failed with reason", () => {
		const f = makeFerment({ status: "running", activePhaseId: "phase-1", phases: [makePhase({ status: "active" })] })
		const result = expectOk(applyCommand(f, { type: "fail_phase", phaseId: "phase-1", reason: "tests failed" }, ctx))
		expect(result.status).toBe("planned")
		expect(result.activePhaseId).toBeUndefined()
		expect(result.phases[0].status).toBe("failed")
		expect(result.phases[0].summary).toBe("tests failed")
	})
})

// ─── complete_ferment ─────────────────────────────────────────────────────────

describe("applyCommand: complete_ferment", () => {
	it("succeeds when all phases terminal", () => {
		const f = makeFerment({
			status: "running",
			phases: [makePhase({ id: "p1", status: "completed" }), makePhase({ id: "p2", status: "skipped", index: 2 })],
		})
		const result = expectOk(applyCommand(f, { type: "complete_ferment" }, ctx))
		expect(result.status).toBe("complete")
	})

	it("rejects when phases are still active or planned", () => {
		const f = makeFerment({
			phases: [makePhase({ id: "p1", status: "active" }), makePhase({ id: "p2", status: "planned", index: 2 })],
		})
		const error = expectError(applyCommand(f, { type: "complete_ferment" }, ctx))
		expect(error.code).toBe("PHASES_NOT_TERMINAL")
		if (error.code === "PHASES_NOT_TERMINAL") {
			expect(error.nonTerminalIds).toEqual(["p1", "p2"])
		}
	})

	it("attaches grade when provided", () => {
		const f = makeFerment({ phases: [makePhase({ status: "completed" })] })
		const grade = makeGrade("B")
		const result = expectOk(applyCommand(f, { type: "complete_ferment", grade }, ctx))
		expect(result.grade).toEqual(grade)
	})

	it("completes explicitly after the final phase leaves the ferment planned", () => {
		const f = makeFerment({
			status: "running",
			activePhaseId: "phase-1",
			phases: [makePhase({ status: "active" })],
		})

		const phaseDone = expectOk(applyCommand(f, { type: "complete_phase", phaseId: "phase-1", summary: "done" }, ctx))
		expect(phaseDone.status).toBe("planned")
		expect(phaseDone.activePhaseId).toBeUndefined()
		expect(phaseDone.phases.every((p) => p.status === "completed")).toBe(true)

		const result = expectOk(applyCommand(phaseDone, { type: "complete_ferment" }, ctx))
		expect(result.status).toBe("complete")
	})

	it("rejects completion when the ferment is already complete", () => {
		const f = makeFerment({ status: "complete", phases: [makePhase({ status: "completed" })] })
		const error = expectError(applyCommand(f, { type: "complete_ferment" }, ctx))
		expect(error.code).toBe("FERMENT_NOT_IN_STATUS")
		expect(error.message).toContain("already complete")
	})

	it("rejects completion when the ferment is abandoned", () => {
		const f = makeFerment({ status: "abandoned", phases: [makePhase({ status: "completed" })] })
		const error = expectError(applyCommand(f, { type: "complete_ferment" }, ctx))
		expect(error.code).toBe("FERMENT_NOT_IN_STATUS")
		expect(error.message).toContain("abandoned")
	})
})

// ─── pause / resume ───────────────────────────────────────────────────────────

describe("applyCommand: pause", () => {
	it("transitions running → paused", () => {
		const result = expectOk(applyCommand(makeFerment({ status: "running" }), { type: "pause" }, ctx))
		expect(result.status).toBe("paused")
	})

	it("transitions planned → paused", () => {
		const result = expectOk(applyCommand(makeFerment({ status: "planned" }), { type: "pause" }, ctx))
		expect(result.status).toBe("paused")
	})

	it("resets running steps to pending on pause", () => {
		const f = makeFerment({
			status: "running",
			activePhaseId: "phase-1",
			phases: [
				makePhase({
					status: "active",
					steps: [
						makeStep({ id: "step-1", status: "running" }),
						makeStep({ id: "step-2", index: 2, status: "pending" }),
					],
				}),
			],
		})
		const result = expectOk(applyCommand(f, { type: "pause" }, ctx))
		expect(result.status).toBe("paused")
		expect(result.phases[0].steps[0].status).toBe("pending")
		expect(result.phases[0].steps[1].status).toBe("pending")
	})

	it("resets running steps in parallel groups to pending on pause", () => {
		const f = makeFerment({
			status: "running",
			activePhaseId: "phase-1",
			phases: [
				makePhase({
					status: "active",
					steps: [
						makeStep({ id: "step-1", status: "running", parallel: true, groupIndex: 1 }),
						makeStep({ id: "step-2", index: 2, status: "running", parallel: true, groupIndex: 1 }),
						makeStep({ id: "step-3", index: 3, status: "done" }),
					],
				}),
			],
		})
		const result = expectOk(applyCommand(f, { type: "pause" }, ctx))
		expect(result.phases[0].steps[0].status).toBe("pending")
		expect(result.phases[0].steps[1].status).toBe("pending")
		expect(result.phases[0].steps[2].status).toBe("done")
	})

	it("rejects pause on draft", () => {
		const error = expectError(applyCommand(makeFerment({ status: "draft" }), { type: "pause" }, ctx))
		expect(error.code).toBe("FERMENT_NOT_IN_STATUS")
	})

	it("rejects pause on already-paused", () => {
		const error = expectError(applyCommand(makeFerment({ status: "paused" }), { type: "pause" }, ctx))
		expect(error.code).toBe("FERMENT_NOT_IN_STATUS")
	})

	it("rejects pause on complete", () => {
		const error = expectError(applyCommand(makeFerment({ status: "complete" }), { type: "pause" }, ctx))
		expect(error.code).toBe("FERMENT_NOT_IN_STATUS")
	})
})

describe("applyCommand: resume", () => {
	it("transitions paused with active phase → running", () => {
		const result = expectOk(
			applyCommand(
				makeFerment({ status: "paused", activePhaseId: "phase-1", phases: [makePhase({ status: "active" })] }),
				{ type: "resume" },
				ctx,
			),
		)
		expect(result.status).toBe("running")
		expect(result.activePhaseId).toBe("phase-1")
	})

	it("transitions paused between phases → planned", () => {
		const result = expectOk(
			applyCommand(
				makeFerment({
					status: "paused",
					activePhaseId: "phase-1",
					phases: [
						makePhase({ id: "phase-1", status: "completed" }),
						makePhase({ id: "phase-2", index: 2, name: "P2", status: "planned" }),
					],
				}),
				{ type: "resume" },
				ctx,
			),
		)
		expect(result.status).toBe("planned")
		expect(result.activePhaseId).toBeUndefined()
	})

	it("rejects resume from running", () => {
		const error = expectError(applyCommand(makeFerment({ status: "running" }), { type: "resume" }, ctx))
		expect(error.code).toBe("FERMENT_NOT_IN_STATUS")
	})

	it("rejects resume from draft", () => {
		const error = expectError(applyCommand(makeFerment({ status: "draft" }), { type: "resume" }, ctx))
		expect(error.code).toBe("FERMENT_NOT_IN_STATUS")
	})

	it("rejects resume from complete", () => {
		const error = expectError(applyCommand(makeFerment({ status: "complete" }), { type: "resume" }, ctx))
		expect(error.code).toBe("FERMENT_NOT_IN_STATUS")
	})

	it("resets orphaned running steps back to pending on resume", () => {
		// Defensive sweep: if pause was bypassed or failed (storage write failure
		// during shutdown, data corruption), an orphaned "running" step would
		// cause determineNextAction to suggest complete_step for a dead subagent.
		// handleResume must reset running → pending even if pause didn't.
		const result = expectOk(
			applyCommand(
				makeFerment({
					status: "paused",
					activePhaseId: "phase-1",
					phases: [
						makePhase({
							id: "phase-1",
							status: "active",
							steps: [
								makeStep({ id: "step-1", status: "running", startedAt: "2026-05-08T14:00:00.000Z" }),
								makeStep({ id: "step-2", index: 2, description: "done one", status: "done" }),
							],
						}),
					],
				}),
				{ type: "resume" },
				ctx,
			),
		)
		expect(result.status).toBe("running")
		const steps = result.phases[0].steps
		// The orphaned running step is reset to pending. Note: like handlePause,
		// handleResume only flips status — it does not clear startedAt. The
		// engine's determineNextAction keys off status, not startedAt, so the
		// step will be correctly re-started rather than completed.
		expect(steps[0].status).toBe("pending")
		// Already-terminal steps are untouched.
		expect(steps[1].status).toBe("done")
	})

	it("is a true no-op on step state when pause already reset all running steps", () => {
		const result = expectOk(
			applyCommand(
				makeFerment({
					status: "paused",
					activePhaseId: "phase-1",
					phases: [
						makePhase({
							id: "phase-1",
							status: "active",
							steps: [
								makeStep({ id: "step-1", status: "pending" }),
								makeStep({ id: "step-2", index: 2, description: "also pending", status: "pending" }),
							],
						}),
					],
				}),
				{ type: "resume" },
				ctx,
			),
		)
		expect(result.status).toBe("running")
		const steps = result.phases[0].steps
		expect(steps[0].status).toBe("pending")
		expect(steps[1].status).toBe("pending")
	})
})

// ─── abandon ──────────────────────────────────────────────────────────────────

describe("applyCommand: abandon", () => {
	it("marks ferment abandoned", () => {
		const result = expectOk(applyCommand(makeFerment(), { type: "abandon" }, ctx))
		expect(result.status).toBe("abandoned")
	})

	it("appends reason to description", () => {
		const f = makeFerment({ description: "Original" })
		const result = expectOk(applyCommand(f, { type: "abandon", reason: "boring" }, ctx))
		expect(result.description).toContain("Original")
		expect(result.description).toContain("boring")
	})
})

// ─── add_decision ─────────────────────────────────────────────────────────────

describe("applyCommand: add_decision", () => {
	it("appends a decision with sequential id", () => {
		const f = makeFerment()
		const result = expectOk(applyCommand(f, { type: "add_decision", title: "T1", description: "D1" }, ctx))
		expect(result.decisions).toHaveLength(1)
		expect(result.decisions[0].id).toBe("D001")
		expect(result.decisions[0].title).toBe("T1")
		expect(result.decisions[0].createdAt).toBe(NOW)
	})

	it("computes id from max existing index + 1 (race-safe)", () => {
		const existing = [
			{ id: "D001", title: "x", description: "x", createdAt: NOW },
			{ id: "D003", title: "y", description: "y", createdAt: NOW },
		]
		const f = makeFerment({ decisions: existing })
		const result = expectOk(applyCommand(f, { type: "add_decision", title: "z", description: "z" }, ctx))
		expect(result.decisions[2].id).toBe("D004")
	})

	it("captures phase and step ids when provided", () => {
		const result = expectOk(
			applyCommand(
				makeFerment(),
				{ type: "add_decision", title: "T", description: "D", phaseId: "p1", stepId: "s1" },
				ctx,
			),
		)
		expect(result.decisions[0].phaseId).toBe("p1")
		expect(result.decisions[0].stepId).toBe("s1")
	})
})

// ─── add_memory ───────────────────────────────────────────────────────────────

describe("applyCommand: add_memory", () => {
	it("appends a memory with valid category", () => {
		const result = expectOk(
			applyCommand(makeFerment(), { type: "add_memory", category: "gotcha", content: "watch out" }, ctx),
		)
		expect(result.memories).toHaveLength(1)
		expect(result.memories[0].id).toBe("M001")
		expect(result.memories[0].category).toBe("gotcha")
	})

	it("rejects invalid category", () => {
		const error = expectError(
			applyCommand(
				makeFerment(),
				// biome-ignore lint/suspicious/noExplicitAny: testing invalid input
				{ type: "add_memory", category: "bogus" as any, content: "x" },
				ctx,
			),
		)
		expect(error.code).toBe("INVALID_CATEGORY")
	})

	it("computes id from max existing index + 1", () => {
		const f = makeFerment({
			memories: [
				{ id: "M001", category: "gotcha", content: "x", createdAt: NOW },
				{ id: "M005", category: "gotcha", content: "y", createdAt: NOW },
			],
		})
		const result = expectOk(applyCommand(f, { type: "add_memory", category: "pattern", content: "z" }, ctx))
		expect(result.memories[2].id).toBe("M006")
	})
})

// ─── grading ──────────────────────────────────────────────────────────────────

describe("applyCommand: set_phase_grade / set_step_grade / set_ferment_grade", () => {
	it("sets phase grade", () => {
		const f = makeFerment({ phases: [makePhase({ status: "completed" })] })
		const grade = makeGrade("B")
		const result = expectOk(applyCommand(f, { type: "set_phase_grade", phaseId: "phase-1", grade }, ctx))
		expect(result.phases[0].grade).toEqual(grade)
	})

	it("sets step grade", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "done" })] })],
		})
		const grade = makeGrade("A")
		const result = expectOk(
			applyCommand(f, { type: "set_step_grade", phaseId: "phase-1", stepId: "step-1", grade }, ctx),
		)
		expect(result.phases[0].steps[0].grade).toEqual(grade)
	})

	it("sets ferment grade", () => {
		const f = makeFerment({ status: "complete" })
		const grade = makeGrade("A")
		const result = expectOk(applyCommand(f, { type: "set_ferment_grade", grade }, ctx))
		expect(result.grade).toEqual(grade)
	})
})

// ─── rename ───────────────────────────────────────────────────────────────────

describe("applyCommand: rename", () => {
	it("changes the ferment name", () => {
		const result = expectOk(applyCommand(makeFerment({ name: "old" }), { type: "rename", name: "new" }, ctx))
		expect(result.name).toBe("new")
	})
})

// ─── purity invariants ────────────────────────────────────────────────────────

describe("applyCommand: purity", () => {
	it("does not mutate input on success", () => {
		const f = makeFerment({ phases: [makePhase({ status: "active" })] })
		const before = JSON.stringify(f)
		applyCommand(f, { type: "complete_phase", phaseId: "phase-1", summary: "done" }, ctx)
		expect(JSON.stringify(f)).toBe(before)
	})

	it("does not mutate input on error", () => {
		const f = makeFerment({ phases: [makePhase({ status: "planned" })] })
		const before = JSON.stringify(f)
		applyCommand(f, { type: "complete_phase", phaseId: "phase-1", summary: "x" }, ctx)
		expect(JSON.stringify(f)).toBe(before)
	})

	it("is deterministic given the same context", () => {
		const f = makeFerment()
		const cmd: Command = { type: "add_decision", title: "T", description: "D" }
		const a = applyCommand(f, cmd, ctx)
		const b = applyCommand(f, cmd, ctx)
		expect(JSON.stringify(a)).toBe(JSON.stringify(b))
	})

	it("updates updatedAt on every successful transition", () => {
		const f = makeFerment({ updatedAt: "2026-01-01T00:00:00.000Z" })
		const result = expectOk(applyCommand(f, { type: "rename", name: "Renamed" }, ctx))
		expect(result.updatedAt).toBe(NOW)
	})
})
