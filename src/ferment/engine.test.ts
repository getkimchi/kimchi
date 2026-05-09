import { describe, expect, it } from "vitest"
import { whatNext } from "./engine.js"
import type { Ferment, Phase, Step } from "./types.js"

function makeF(overrides?: Partial<Ferment>): Ferment {
	return {
		id: "fefefefe-fefe-fefe-fefe-fefefefefefe",
		name: "Build Tetris",
		status: "draft",
		mode: "auto",
		worktree: { path: "/test" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: "2024-01-01T00:00:00Z",
		updatedAt: "2024-01-01T00:00:00Z",
		...overrides,
	}
}

function makeP(overrides?: Partial<Phase>): Phase {
	return { id: "p1", index: 1, name: "Setup", goal: "G1", status: "planned", steps: [], ...overrides }
}

function makeS(overrides?: Partial<Step>): Step {
	return { id: "s1", index: 1, description: "Do X", status: "pending", ...overrides }
}

describe("whatNext", () => {
	describe("auto mode (default)", () => {
		it("draft → scope action", () => {
			const a = whatNext(makeF())
			expect(a.kind).toBe("scope")
			expect(a.message).toContain("Collect") // simplified message
		})

		it("planned → activate first phase", () => {
			const a = whatNext(makeF({ status: "planned", phases: [makeP(), makeP({ id: "p2", index: 2, name: "P2" })] }))
			expect(a.kind).toBe("activate_phase")
			if (a.kind === "activate_phase") {
				expect(a.phaseId).toBe("p1")
				expect(a.message).toContain("Activate") // simplified message
			}
		})

		it("running with no steps → refine", () => {
			const a = whatNext(makeF({ status: "running", activePhaseId: "p1", phases: [makeP({ status: "active" })] }))
			expect(a.kind).toBe("refine")
			expect(a.message).toContain("Break") // simplified message
		})

		it("running with pending step → start_step", () => {
			const phase = makeP({ status: "active", steps: [makeS()] })
			const a = whatNext(makeF({ status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("start_step")
			expect(a.message).toContain("Start") // simplified message
		})

		it("all steps terminal → complete_phase", () => {
			const phase = makeP({
				status: "active",
				steps: [makeS({ status: "done" }), makeS({ id: "s2", index: 2, status: "verified" })],
			})
			const a = whatNext(makeF({ status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("complete_phase")
			expect(a.message).toContain("Mark") // simplified message
		})
	})

	describe("plan mode", () => {
		it("draft → scope", () => {
			const a = whatNext(makeF({ mode: "plan" }))
			expect(a.kind).toBe("scope")
			expect(a.message).toContain("Collect") // simplified message
		})

		it("planned → activate_phase", () => {
			const a = whatNext(makeF({ mode: "plan", status: "planned", phases: [makeP(), makeP({ id: "p2", index: 2 })] }))
			expect(a.kind).toBe("activate_phase")
			if (a.kind === "activate_phase") {
				expect(a.phaseId).toBe("p1")
				expect(a.message).toContain("Activate") // simplified message
			}
		})

		it("running with no steps → refine", () => {
			const a = whatNext(
				makeF({ mode: "plan", status: "running", activePhaseId: "p1", phases: [makeP({ status: "active" })] }),
			)
			expect(a.kind).toBe("refine")
			expect(a.message).toContain("Break") // simplified message
		})

		it("running with pending step → start_step", () => {
			const phase = makeP({ status: "active", steps: [makeS()] })
			const a = whatNext(makeF({ mode: "plan", status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("start_step")
			expect(a.message).toContain("Start") // simplified message
		})

		it("running all terminal → complete_phase", () => {
			const phase = makeP({ status: "active", steps: [makeS({ status: "done" })] })
			const a = whatNext(makeF({ mode: "plan", status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("complete_phase")
			expect(a.message).toContain("Mark") // simplified message
		})

		it("complete → complete_ferment (terminal state is terminal)", () => {
			const a = whatNext(makeF({ mode: "plan", status: "complete" }))
			expect(a.kind).toBe("complete_ferment")
		})

		it("running with failed step → recover_step", () => {
			const phase = makeP({ status: "active", steps: [makeS({ status: "failed" })] })
			const a = whatNext(makeF({ mode: "plan", status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("recover_step")
		})

		it("running with failed phase → recover_phase", () => {
			const a = whatNext(
				makeF({ mode: "plan", status: "running", activePhaseId: "p1", phases: [makeP({ status: "failed" })] }),
			)
			expect(a.kind).toBe("recover_phase")
		})
	})

	describe("exec mode", () => {
		it("draft → scope", () => {
			const a = whatNext(makeF({ mode: "exec" }))
			expect(a.kind).toBe("scope")
			expect(a.message).toContain("Collect") // simplified message
		})

		it("planned → activate", () => {
			const a = whatNext(makeF({ mode: "exec", status: "planned", phases: [makeP()] }))
			expect(a.kind).toBe("activate_phase")
			if (a.kind === "activate_phase") {
				expect(a.message).toContain("Activate") // simplified message
			}
		})

		it("running with no steps → refine", () => {
			const a = whatNext(
				makeF({ mode: "exec", status: "running", activePhaseId: "p1", phases: [makeP({ status: "active" })] }),
			)
			expect(a.kind).toBe("refine")
			expect(a.message).toContain("Break") // simplified message
		})

		it("running with pending → start_step", () => {
			const phase = makeP({ status: "active", steps: [makeS()] })
			const a = whatNext(makeF({ mode: "exec", status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("start_step")
			expect(a.message).toContain("Start") // simplified message
		})

		it("running all terminal → complete_phase", () => {
			const phase = makeP({ status: "active", steps: [makeS({ status: "done" })] })
			const a = whatNext(makeF({ mode: "exec", status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("complete_phase")
			expect(a.message).toContain("Mark") // simplified message
		})
	})

	describe("status edge cases", () => {
		it("paused → pause action", () => {
			const a = whatNext(makeF({ status: "paused" }))
			expect(a.kind).toBe("paused")
		})

		it("no active phase but running → pause", () => {
			const a = whatNext(makeF({ status: "running", phases: [makeP({ status: "planned" })] }))
			expect(a.kind).toBe("paused")
			expect(a.message).toContain("paused") // simplified message
		})

		it("complete → complete_ferment", () => {
			const a = whatNext(makeF({ status: "complete" }))
			expect(a.kind).toBe("complete_ferment")
		})

		it("abandoned → complete_ferment", () => {
			const a = whatNext(makeF({ status: "abandoned" }))
			expect(a.kind).toBe("complete_ferment")
			expect(a.message).toContain("abandoned")
		})

		it("running with failed step → recover_step", () => {
			const phase = makeP({ status: "active", steps: [makeS({ status: "failed" })] })
			const a = whatNext(makeF({ status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("recover_step")
		})

		it("running with failed phase → recover_phase", () => {
			const a = whatNext(makeF({ status: "running", activePhaseId: "p1", phases: [makeP({ status: "failed" })] }))
			expect(a.kind).toBe("recover_phase")
		})

		it("all non-failed steps terminal → complete_phase", () => {
			const phase = makeP({
				status: "active",
				steps: [makeS({ status: "skipped" }), makeS({ id: "s2", index: 2, status: "done" })],
			})
			const a = whatNext(makeF({ status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("complete_phase")
		})

		it("only-running-step phase → complete_step (not start_step)", () => {
			// Regression: findNextStep used to return a running step, causing the engine to
			// suggest start_step instead of falling through to the runningStep branch.
			const phase = makeP({ status: "active", steps: [makeS({ status: "running" })] })
			const a = whatNext(makeF({ status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("complete_step")
		})

		it("running step + later pending step → start_step on the pending one", () => {
			const phase = makeP({
				status: "active",
				steps: [makeS({ id: "s1", index: 1, status: "running" }), makeS({ id: "s2", index: 2, status: "pending" })],
			})
			const a = whatNext(makeF({ status: "running", activePhaseId: "p1", phases: [phase] }))
			expect(a.kind).toBe("start_step")
			if (a.kind === "start_step") expect(a.stepId).toBe("s2")
		})
	})
})
