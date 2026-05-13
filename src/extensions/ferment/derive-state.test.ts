import { describe, expect, it } from "vitest"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { type RuntimeReader, deriveFermentState } from "./derive-state.js"
import { MAX_BLOCK_RETRIES } from "./state.js"

function makeStep(overrides: Partial<Step> = {}): Step {
	return {
		id: "step-1",
		index: 1,
		description: "Do the thing",
		status: "pending",
		...overrides,
	}
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
	return {
		id: "phase-1",
		index: 1,
		name: "Phase 1",
		goal: "Build 1",
		status: "planned",
		steps: [makeStep()],
		...overrides,
	}
}

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-1",
		name: "Test Ferment",
		goal: "Ship.",
		successCriteria: "Works.",
		constraints: [],
		status: "running",
		mode: "auto",
		worktree: { path: "/tmp/test", branch: undefined, commit: undefined },
		scoping: {},
		phases: [makePhase()],
		decisions: [],
		memories: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}
}

/** Default runtime reader that returns "nothing recorded" for everything.
 *  Tests override individual methods to inject specific facts. */
function makeRuntime(overrides: Partial<RuntimeReader> = {}): RuntimeReader {
	return {
		getBlockRetry: () => 0,
		getCorrectiveStep: () => undefined,
		getPhaseStartRef: () => undefined,
		getStepStartRef: () => undefined,
		hasAfterScopeContinuation: () => false,
		...overrides,
	}
}

describe("deriveFermentState — happy path", () => {
	it("returns active phase + nextAction for a fresh phase-active ferment", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "pending" })] })],
		})
		const state = deriveFermentState(f, makeRuntime())
		expect(state.activePhase?.id).toBe("phase-1")
		expect(state.activeStep).toBeUndefined() // no step running yet
		expect(state.afterScopeContinuation).toBe(false)
		expect(state.blocked).toBeUndefined()
		expect(state.phaseRetry).toBeUndefined()
		expect(state.correctiveStep).toBeUndefined()
	})

	it("surfaces the active step when a step is running", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					status: "active",
					steps: [makeStep({ status: "running", verification: { command: "pnpm test" } })],
				}),
			],
		})
		const state = deriveFermentState(f, makeRuntime())
		expect(state.activeStep?.id).toBe("step-1")
		expect(state.activeStep?.verifyCommand).toBe("pnpm test")
	})
})

describe("deriveFermentState — runtime context", () => {
	it("surfaces phaseRetry when block retries have been used", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active" })],
		})
		const state = deriveFermentState(f, makeRuntime({ getBlockRetry: () => 2 }))
		expect(state.phaseRetry).toEqual({
			phaseId: "phase-1",
			used: 2,
			max: MAX_BLOCK_RETRIES,
			atRiskOfEscalation: false,
		})
	})

	it("marks phaseRetry.atRiskOfEscalation when retries reach MAX_BLOCK_RETRIES", () => {
		const f = makeFerment({
			phases: [makePhase({ status: "active" })],
		})
		const state = deriveFermentState(f, makeRuntime({ getBlockRetry: () => MAX_BLOCK_RETRIES }))
		expect(state.phaseRetry?.atRiskOfEscalation).toBe(true)
	})

	it("does NOT include phaseRetry when no retries have been recorded", () => {
		const f = makeFerment({ phases: [makePhase({ status: "active" })] })
		const state = deriveFermentState(f, makeRuntime({ getBlockRetry: () => 0 }))
		expect(state.phaseRetry).toBeUndefined()
	})

	it("surfaces lastGradedPhase with grade + correctiveText when present", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					id: "phase-1",
					status: "completed",
					grade: { grade: "B", rationale: "ok", gradedAt: "2026-01-01T00:00:00.000Z" },
				}),
			],
		})
		const state = deriveFermentState(
			f,
			makeRuntime({
				getCorrectiveStep: () => "be more careful with edge cases",
			}),
		)
		expect(state.lastGradedPhase).toEqual({
			phaseId: "phase-1",
			phaseName: "Phase 1",
			grade: { grade: "B", rationale: "ok", gradedAt: "2026-01-01T00:00:00.000Z" },
			correctiveText: "be more careful with edge cases",
		})
	})

	it("surfaces lastGradedPhase even when no corrective text is recorded", () => {
		// An A-graded phase has no corrective step but should still appear in
		// lastGradedPhase so the planner-supplement can render whatever feedback
		// the grade implies.
		const f = makeFerment({
			phases: [
				makePhase({
					id: "phase-1",
					status: "completed",
					grade: { grade: "A", rationale: "clean", gradedAt: "2026-01-01T00:00:00.000Z" },
				}),
			],
		})
		const state = deriveFermentState(f, makeRuntime())
		expect(state.lastGradedPhase?.phaseId).toBe("phase-1")
		expect(state.lastGradedPhase?.correctiveText).toBeUndefined()
	})

	it("does NOT include lastGradedPhase when no graded phases exist", () => {
		const f = makeFerment({ phases: [makePhase({ status: "planned" })] })
		const state = deriveFermentState(f, makeRuntime())
		expect(state.lastGradedPhase).toBeUndefined()
	})

	it("surfaces correctiveStep (deprecated back-compat field) from the LAST graded completed phase", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					id: "phase-1",
					status: "completed",
					grade: { grade: "F", rationale: "x", gradedAt: "2026-01-01T00:00:00.000Z" },
				}),
				makePhase({
					id: "phase-2",
					index: 2,
					name: "Phase 2",
					goal: "Build 2",
					status: "completed",
					grade: { grade: "B", rationale: "y", gradedAt: "2026-01-01T00:00:00.000Z" },
				}),
				makePhase({
					id: "phase-3",
					index: 3,
					name: "Phase 3",
					goal: "Build 3",
					status: "planned",
				}),
			],
		})
		// Runtime has corrective text only for phase-2 (the most recent graded).
		const state = deriveFermentState(
			f,
			makeRuntime({
				getCorrectiveStep: (_fId, phaseId) => (phaseId === "phase-2" ? "Add a regression test next time." : undefined),
			}),
		)
		expect(state.correctiveStep).toEqual({
			phaseId: "phase-2",
			text: "Add a regression test next time.",
		})
	})

	it("ignores correctiveStep on uncompleted phases even if recorded", () => {
		// Defensive: runtime might have stale corrective text for a still-active
		// phase. We only surface text for completed-with-grade phases.
		const f = makeFerment({
			phases: [makePhase({ status: "active" })],
		})
		const state = deriveFermentState(f, makeRuntime({ getCorrectiveStep: () => "stale text from before" }))
		expect(state.correctiveStep).toBeUndefined()
	})

	it("includes git refs when runtime has them", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					status: "active",
					steps: [makeStep({ status: "running" })],
				}),
			],
		})
		const state = deriveFermentState(
			f,
			makeRuntime({
				getPhaseStartRef: () => "phase-sha",
				getStepStartRef: () => "step-sha",
			}),
		)
		expect(state.phaseStartRef).toBe("phase-sha")
		expect(state.stepStartRef).toBe("step-sha")
	})

	it("surfaces afterScopeContinuation when runtime flags it", () => {
		const f = makeFerment()
		const state = deriveFermentState(f, makeRuntime({ hasAfterScopeContinuation: () => true }))
		expect(state.afterScopeContinuation).toBe(true)
	})
})

describe("deriveFermentState — terminal/blocked states", () => {
	it("marks paused ferments as blocked with a recovery hint", () => {
		const f = makeFerment({ status: "paused" })
		const state = deriveFermentState(f, makeRuntime())
		expect(state.blocked?.reason).toContain("paused")
		expect(state.blocked?.recoveryHint).toContain("Resume")
	})

	it("marks abandoned ferments as blocked", () => {
		const f = makeFerment({ status: "abandoned" })
		const state = deriveFermentState(f, makeRuntime())
		expect(state.blocked?.reason).toContain("abandoned")
		expect(state.blocked?.recoveryHint).toContain("new ferment")
	})

	it("marks completed ferments as blocked (no further action)", () => {
		const f = makeFerment({ status: "complete" })
		const state = deriveFermentState(f, makeRuntime())
		expect(state.blocked?.reason).toContain("complete")
		// No recovery hint for completed — there's nothing to recover from.
		expect(state.blocked?.recoveryHint).toBeUndefined()
	})

	it("does NOT mark draft/planned/running ferments as blocked", () => {
		for (const status of ["draft", "planned", "running"] as const) {
			const f = makeFerment({ status })
			const state = deriveFermentState(f, makeRuntime())
			expect(state.blocked).toBeUndefined()
		}
	})
})

describe("deriveFermentState — purity", () => {
	it("does not mutate the ferment it reads", () => {
		const f = makeFerment({
			phases: [
				makePhase({
					status: "active",
					steps: [makeStep({ status: "running" })],
				}),
			],
		})
		const before = JSON.stringify(f)
		deriveFermentState(
			f,
			makeRuntime({
				getBlockRetry: () => 2,
				getCorrectiveStep: () => "fix it",
				getPhaseStartRef: () => "sha",
				getStepStartRef: () => "sha2",
				hasAfterScopeContinuation: () => true,
			}),
		)
		expect(JSON.stringify(f)).toBe(before)
	})

	it("calls runtime reader methods, never mutates them", () => {
		// Capture all read calls and assert no writes (no set/clear etc.) happen.
		const reads: string[] = []
		const runtime: RuntimeReader = {
			getBlockRetry: (_f, p) => {
				reads.push(`getBlockRetry:${p}`)
				return 0
			},
			getCorrectiveStep: (_f, p) => {
				reads.push(`getCorrectiveStep:${p}`)
				return undefined
			},
			getPhaseStartRef: (_f, p) => {
				reads.push(`getPhaseStartRef:${p}`)
				return undefined
			},
			getStepStartRef: (_f, p, s) => {
				reads.push(`getStepStartRef:${p}:${s}`)
				return undefined
			},
			hasAfterScopeContinuation: (f) => {
				reads.push(`hasAfterScopeContinuation:${f}`)
				return false
			},
		}
		const f = makeFerment({
			phases: [makePhase({ status: "active", steps: [makeStep({ status: "running" })] })],
		})
		deriveFermentState(f, runtime)
		// At minimum the active-phase retry, start-ref, after-scope continuation
		// must have been read. No write-style method exists on RuntimeReader so
		// the no-write claim is structurally guaranteed.
		expect(reads).toContain("getBlockRetry:phase-1")
		expect(reads).toContain("getPhaseStartRef:phase-1")
		expect(reads).toContain("hasAfterScopeContinuation:ferment-1")
	})
})
