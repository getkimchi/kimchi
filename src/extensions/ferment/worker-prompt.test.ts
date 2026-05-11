import { describe, expect, it } from "vitest"
import type { Decision, Ferment, Memory, Phase, Step } from "../../ferment/types.js"
import { buildWorkerContext } from "./worker-prompt.js"

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-1",
		name: "Test Ferment",
		status: "running",
		mode: "auto",
		worktree: { path: "/tmp/test" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: "2026-05-09T00:00:00Z",
		updatedAt: "2026-05-09T00:00:00Z",
		...overrides,
	}
}

function makePhase(overrides: Partial<Phase> = {}): Phase {
	return {
		id: "phase-1",
		index: 1,
		name: "Build it",
		goal: "Ship a working thing",
		status: "active",
		steps: [],
		...overrides,
	}
}

function makeStep(overrides: Partial<Step> = {}): Step {
	return {
		id: "step-1",
		index: 1,
		description: "Do the thing",
		status: "pending",
		...overrides,
	}
}

describe("buildWorkerContext", () => {
	it("includes ferment name, phase goal, and step description", () => {
		const phase = makePhase({ steps: [makeStep()] })
		const f = makeFerment({ name: "Auth rewrite", phases: [phase] })

		const ctx = buildWorkerContext(f, phase, phase.steps[0])
		expect(ctx).toContain("Auth rewrite")
		expect(ctx).toContain("Build it")
		expect(ctx).toContain("Ship a working thing")
		expect(ctx).toContain("Do the thing")
	})

	it("includes verification command when present", () => {
		const step = makeStep({ verification: { command: "pnpm test" } })
		const phase = makePhase({ steps: [step] })
		const f = makeFerment({ phases: [phase] })

		const ctx = buildWorkerContext(f, phase, step)
		expect(ctx).toContain("Verify when done:")
		expect(ctx).toContain("pnpm test")
	})

	it("includes prior completed steps with their summaries", () => {
		const phase = makePhase({
			steps: [
				makeStep({ id: "s1", index: 1, status: "done", summary: "Created the User type" }),
				makeStep({ id: "s2", index: 2, status: "verified", summary: "Wrote the migration" }),
				makeStep({ id: "s3", index: 3, status: "pending", description: "Wire it up" }),
			],
		})
		const f = makeFerment({ phases: [phase] })

		const ctx = buildWorkerContext(f, phase, phase.steps[2])
		expect(ctx).toContain("Prior steps in this phase (2)")
		expect(ctx).toContain("Step 1")
		expect(ctx).toContain("Created the User type")
		expect(ctx).toContain("Step 2")
		expect(ctx).toContain("Wrote the migration")
		// The current step itself should NOT be listed in prior steps
		expect(ctx).not.toContain("Wire it up — ")
	})

	it("marks skipped steps differently from completed", () => {
		const phase = makePhase({
			steps: [
				makeStep({ id: "s1", index: 1, status: "skipped", summary: "Decided not to" }),
				makeStep({ id: "s2", index: 2, status: "pending", description: "Next" }),
			],
		})
		const f = makeFerment({ phases: [phase] })

		const ctx = buildWorkerContext(f, phase, phase.steps[1])
		expect(ctx).toContain("⊘ skipped")
		expect(ctx).not.toMatch(/✓ Step 1/)
	})

	it("excludes pending and running steps from prior list", () => {
		const phase = makePhase({
			steps: [
				makeStep({ id: "s1", index: 1, status: "running" }),
				makeStep({ id: "s2", index: 2, status: "pending" }),
				makeStep({ id: "s3", index: 3, status: "pending", description: "Target" }),
			],
		})
		const f = makeFerment({ phases: [phase] })

		const ctx = buildWorkerContext(f, phase, phase.steps[2])
		expect(ctx).not.toContain("Prior steps in this phase")
	})

	it("truncates long prior step summaries", () => {
		const longSummary = "x".repeat(500)
		const phase = makePhase({
			steps: [
				makeStep({ id: "s1", index: 1, status: "done", summary: longSummary }),
				makeStep({ id: "s2", index: 2, status: "pending", description: "Target" }),
			],
		})
		const f = makeFerment({ phases: [phase] })

		const ctx = buildWorkerContext(f, phase, phase.steps[1])
		expect(ctx).toContain("…")
		// The full 500 'x's should not appear verbatim
		expect(ctx.length).toBeLessThan(500 + 200) // some prologue + truncated body
	})

	it("includes recent decisions when present", () => {
		const decisions: Decision[] = [
			{
				id: "d1",
				title: "Use Zod for validation",
				description: "Better DX than ajv",
				createdAt: "2026-05-09T00:00:00Z",
			},
		]
		const phase = makePhase({ steps: [makeStep()] })
		const f = makeFerment({ phases: [phase], decisions })

		const ctx = buildWorkerContext(f, phase, phase.steps[0])
		expect(ctx).toContain("Decisions to honor:")
		expect(ctx).toContain("Use Zod for validation")
	})

	it("includes recent memories when present", () => {
		const memories: Memory[] = [
			{
				id: "m1",
				category: "gotcha",
				content: "Date.parse('') returns NaN, not 0",
				createdAt: "2026-05-09T00:00:00Z",
			},
		]
		const phase = makePhase({ steps: [makeStep()] })
		const f = makeFerment({ phases: [phase], memories })

		const ctx = buildWorkerContext(f, phase, phase.steps[0])
		expect(ctx).toContain("Memories to apply:")
		expect(ctx).toContain("[gotcha]")
		expect(ctx).toContain("Date.parse")
	})

	it("limits to the most recent 5 decisions and memories", () => {
		const decisions: Decision[] = Array.from({ length: 8 }, (_, i) => ({
			id: `d${i}`,
			title: `Decision ${i}`,
			description: `D${i}`,
			createdAt: "2026-05-09T00:00:00Z",
		}))
		const phase = makePhase({ steps: [makeStep()] })
		const f = makeFerment({ phases: [phase], decisions })

		const ctx = buildWorkerContext(f, phase, phase.steps[0])
		// Most recent 5 are decisions 3..7
		expect(ctx).toContain("Decision 3")
		expect(ctx).toContain("Decision 7")
		expect(ctx).not.toContain("Decision 0")
		expect(ctx).not.toContain("Decision 2")
	})

	it("includes constraints when set", () => {
		const phase = makePhase({ steps: [makeStep()] })
		const f = makeFerment({
			phases: [phase],
			scoping: {
				constraints: { answer: "Must be backwards compatible", confirmedAt: "2026-05-09T00:00:00Z" },
			},
		})

		const ctx = buildWorkerContext(f, phase, phase.steps[0])
		expect(ctx).toContain("Constraints:")
		expect(ctx).toContain("Must be backwards compatible")
	})

	it("opts.includeDecisions=false suppresses the decisions section", () => {
		const decisions: Decision[] = [{ id: "d1", title: "Use Zod", description: "DX", createdAt: "2026-05-09T00:00:00Z" }]
		const phase = makePhase({ steps: [makeStep()] })
		const f = makeFerment({ phases: [phase], decisions })

		const ctx = buildWorkerContext(f, phase, phase.steps[0], { includeDecisions: false })
		expect(ctx).not.toContain("Decisions to honor")
	})
})
