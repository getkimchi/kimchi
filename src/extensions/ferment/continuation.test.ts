import { describe, expect, it } from "vitest"
import type { Ferment, Phase } from "../../ferment/types.js"
import { decideContinuation } from "./continuation.js"

function phase(overrides: Partial<Phase>): Phase {
	return {
		id: "phase-1",
		index: 1,
		name: "Phase",
		goal: "Do work",
		status: "planned",
		steps: [],
		...overrides,
	}
}

function ferment(overrides: Partial<Ferment>): Ferment {
	const now = "2026-01-01T00:00:00.000Z"
	return {
		id: "ferment-1",
		name: "Continuation Ferment",
		status: "planned",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	}
}

describe("decideContinuation", () => {
	it("continues a manual ferment into its first planned phase", () => {
		const f = ferment({
			phases: [phase({ id: "phase-1", index: 1, status: "planned" })],
		})

		const decision = decideContinuation(f, "manual")

		expect(decision.type).toBe("continue")
		expect(decision.action).toEqual(
			expect.objectContaining({
				kind: "activate_phase",
				phaseId: "phase-1",
			}),
		)
	})

	it("waits at a manual boundary before moving to a later phase", () => {
		const f = ferment({
			phases: [
				phase({ id: "phase-1", index: 1, status: "completed" }),
				phase({ id: "phase-2", index: 2, status: "planned" }),
			],
		})

		const decision = decideContinuation(f, "manual")

		expect(decision.type).toBe("wait_manual_boundary")
		expect(decision.action).toEqual(
			expect.objectContaining({
				kind: "activate_phase",
				phaseId: "phase-2",
			}),
		)
	})

	it("allows explicit manual boundary approval", () => {
		const f = ferment({
			phases: [
				phase({ id: "phase-1", index: 1, status: "completed" }),
				phase({ id: "phase-2", index: 2, status: "planned" }),
			],
		})

		const decision = decideContinuation(f, "manual", { allowManualPhaseBoundary: true })

		expect(decision.type).toBe("continue")
		expect(decision.action).toEqual(
			expect.objectContaining({
				kind: "activate_phase",
				phaseId: "phase-2",
			}),
		)
	})

	it("continues automated policy across a phase boundary", () => {
		const f = ferment({
			phases: [
				phase({ id: "phase-1", index: 1, status: "completed" }),
				phase({ id: "phase-2", index: 2, status: "planned" }),
			],
		})

		const decision = decideContinuation(f, "automated")

		expect(decision.type).toBe("continue")
		expect(decision.action).toEqual(
			expect.objectContaining({
				kind: "activate_phase",
				phaseId: "phase-2",
			}),
		)
	})

	it("continues manual work inside an active phase", () => {
		const f = ferment({
			status: "running",
			activePhaseId: "phase-1",
			phases: [
				phase({
					id: "phase-1",
					index: 1,
					status: "active",
					steps: [{ id: "step-1", index: 1, description: "Do it", status: "pending" }],
				}),
			],
		})

		const decision = decideContinuation(f, "manual")

		expect(decision.type).toBe("continue")
		expect(decision.action).toEqual(
			expect.objectContaining({
				kind: "start_step",
				phaseId: "phase-1",
				stepId: "step-1",
			}),
		)
	})

	it("does not continue paused or terminal ferments", () => {
		const paused = ferment({ status: "paused", phases: [phase({ id: "phase-1", status: "planned" })] })
		const complete = ferment({ status: "complete", phases: [phase({ id: "phase-1", status: "completed" })] })

		expect(decideContinuation(paused, "automated").type).toBe("paused")
		expect(decideContinuation(complete, "automated").type).toBe("idle")
	})
})
