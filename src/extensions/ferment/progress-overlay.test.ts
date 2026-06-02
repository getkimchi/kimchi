import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import {
	buildPhaseListOptions,
	buildPhaseListTitle,
	buildPhaseStepOptions,
	buildStepDetailTitle,
	handlePhaseAction,
	handleStepAction,
} from "./progress-overlay.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { getActive, setActive } from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"

function createHarness(): {
	runtime: FermentRuntime
	storage: FermentEventStore
	ferment: Ferment
	phase: Phase
	step: Step
	ctx: ExtensionCommandContext
	setActiveSpy: ReturnType<typeof vi.fn>
	clearStepStartSpy: ReturnType<typeof vi.fn>
} {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-progress-overlay-test-")))
	const setActiveSpy = vi.fn()
	const clearStepStartSpy = vi.fn()
	const runtime: FermentRuntime = {
		...createDefaultFermentRuntime(),
		getStorage: () => storage,
		setActive: setActiveSpy,
		clearStepStart: clearStepStartSpy,
	}
	const applyAndPersist = createApplyAndPersist(runtime)
	const draft = storage.create("Progress Overlay")
	const scoped = applyAndPersist(draft.id, {
		type: "scope",
		goal: "Goal",
		successCriteria: "Works",
		constraints: [],
		phases: [{ name: "Phase", goal: "Build", steps: [{ description: "Do it" }] }],
	})
	if (!scoped.ok) throw new Error(scoped.error.message)
	const activated = applyAndPersist(scoped.ferment.id, {
		type: "activate_phase",
		phaseId: scoped.ferment.phases[0].id,
	})
	if (!activated.ok) throw new Error(activated.error.message)
	const phase = activated.ferment.phases[0]
	const step = phase.steps[0]
	const started = applyAndPersist(activated.ferment.id, {
		type: "start_step",
		phaseId: phase.id,
		stepId: step.id,
	})
	if (!started.ok) throw new Error(started.error.message)
	const ferment = started.ferment
	const freshPhase = ferment.phases[0]
	const freshStep = freshPhase.steps[0]
	const ctx = { ui: { notify: vi.fn(), input: vi.fn() } } as unknown as ExtensionCommandContext
	setActiveSpy.mockClear()
	clearStepStartSpy.mockClear()
	return { runtime, storage, ferment, phase: freshPhase, step: freshStep, ctx, setActiveSpy, clearStepStartSpy }
}

afterEach(() => {
	setActive(undefined)
})

describe("progress overlay action handlers", () => {
	it("uses injected runtime time for the phase list title", () => {
		const { runtime, ferment } = createHarness()
		runtime.now = () => new Date("2026-05-11T12:05:00.000Z")
		runtime.getLastHumanInputAt = () => new Date("2026-05-11T12:03:00.000Z")

		const title = buildPhaseListTitle(ferment, runtime)

		expect(title).toContain("2m ago")
	})

	it("uses injected runtime state for step actions", async () => {
		const { runtime, storage, ferment, phase, step, ctx, setActiveSpy, clearStepStartSpy } = createHarness()

		await handleStepAction("Skip step", ferment, phase, step, ctx, runtime)

		const freshStep = storage.get(ferment.id)?.phases[0].steps[0]
		expect(freshStep?.status).toBe("skipped")
		expect(setActiveSpy).toHaveBeenCalledWith(expect.objectContaining({ id: ferment.id }))
		expect(clearStepStartSpy).toHaveBeenCalledWith(ferment.id, phase.id, step.id)
		expect(getActive()).toBeUndefined()
		expect(ctx.ui.notify).toHaveBeenCalledWith("Step 1 skipped.")
	})

	it("uses injected runtime state for phase actions", async () => {
		const { runtime, storage, ferment, phase, ctx, setActiveSpy } = createHarness()

		await handlePhaseAction("Skip phase", ferment, phase, ctx, runtime)

		const freshPhase = storage.get(ferment.id)?.phases[0]
		expect(freshPhase?.status).toBe("skipped")
		expect(setActiveSpy).toHaveBeenCalledWith(expect.objectContaining({ id: ferment.id }))
		expect(getActive()).toBeUndefined()
		expect(ctx.ui.notify).toHaveBeenCalledWith(`Phase "${phase.name}" skipped.`)
	})
})

describe("progress overlay parallel rendering", () => {
	// Build a ferment with two cohort-1 phases and one phase that has two
	// parallel-safe steps. Verifies every overlay layer (L1, L2, L3) surfaces
	// parallelism — this is the in-process equivalent of an interactive smoke
	// against the built binary.
	function makeParallelFerment(): Ferment {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-parallel-render-test-")))
		const runtime: FermentRuntime = { ...createDefaultFermentRuntime(), getStorage: () => storage }
		const applyAndPersist = createApplyAndPersist(runtime)
		const draft = storage.create("Parallel Render")
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			goal: "Goal",
			successCriteria: "Works",
			constraints: [],
			phases: [
				{
					name: "Explore frontend",
					goal: "Map UI surface",
					parallel_group: 1,
					steps: [{ description: "Read components" }],
				},
				{
					name: "Explore backend",
					goal: "Map API surface",
					parallel_group: 1,
					steps: [{ description: "Read handlers" }],
				},
				{
					name: "Implement",
					goal: "Wire it up",
					steps: [
						{ description: "Update token A", parallel_group: 1 },
						{ description: "Update token B", parallel_group: 1 },
						{ description: "Final wire-up" },
					],
				},
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		return scoped.ferment
	}

	it("L1 phase list shows cohort marker and parallel-step count", () => {
		const ferment = makeParallelFerment()
		const options = buildPhaseListOptions(ferment)

		// Cohort phases get the colored group marker
		const frontendLine = options.find((o) => o.includes("Explore frontend"))
		const backendLine = options.find((o) => o.includes("Explore backend"))
		expect(frontendLine).toMatch(/∥1/)
		expect(backendLine).toMatch(/∥1/)

		// "Implement" has no cohort but has 2 parallel-safe steps
		const implementLine = options.find((o) => o.includes("Implement"))
		expect(implementLine).not.toMatch(/∥\d/)
		expect(implementLine).toMatch(/\(2∥\)/)
	})

	it("L2 step list marks each parallel-safe step with ∥", () => {
		const ferment = makeParallelFerment()
		const implement = ferment.phases.find((p) => p.name === "Implement")
		if (!implement) throw new Error("Implement phase missing")
		const stepLines = buildPhaseStepOptions(implement)

		const tokenA = stepLines.find((l) => l.includes("Update token A"))
		const tokenB = stepLines.find((l) => l.includes("Update token B"))
		const finalWire = stepLines.find((l) => l.includes("Final wire-up"))

		expect(tokenA).toMatch(/∥/)
		expect(tokenB).toMatch(/∥/)
		expect(finalWire).not.toMatch(/∥/)
	})

	it("L3 step detail labels parallel-group steps explicitly", () => {
		const ferment = makeParallelFerment()
		const implement = ferment.phases.find((p) => p.name === "Implement")
		if (!implement) throw new Error("Implement phase missing")
		const parallelStep = implement.steps.find((s) => s.description === "Update token A")
		const serialStep = implement.steps.find((s) => s.description === "Final wire-up")
		if (!parallelStep || !serialStep) throw new Error("steps missing")

		expect(buildStepDetailTitle(implement, parallelStep)).toMatch(/parallel group 1/)
		expect(buildStepDetailTitle(implement, serialStep)).not.toMatch(/parallel group/)
	})

	it("shows todo counts for phase and step overlays", () => {
		const ferment = makeParallelFerment()
		const todoCountsByScope = new Map([
			["phase-1", { total: 4, completed: 1, pending: 3, blocked: 0, inProgress: 0 }],
			["phase-3", { total: 3, completed: 2, pending: 1, blocked: 0, inProgress: 0 }],
			["phase-3:step-1", { total: 2, completed: 1, pending: 1, blocked: 0, inProgress: 0 }],
			["phase-3:step-3", { total: 0, completed: 0, pending: 0, blocked: 0, inProgress: 0 }],
		])

		const resolver = (scope: { fermentId: string; phaseId?: string; stepId?: string }) => {
			if (scope?.phaseId && scope?.stepId) {
				return (
					todoCountsByScope.get(`${scope.phaseId}:${scope.stepId}`) ?? {
						total: 0,
						completed: 0,
						pending: 0,
						blocked: 0,
						inProgress: 0,
					}
				)
			}
			if (scope?.phaseId) {
				return (
					todoCountsByScope.get(scope.phaseId) ?? {
						total: 0,
						completed: 0,
						pending: 0,
						blocked: 0,
						inProgress: 0,
					}
				)
			}
			return { total: 0, completed: 0, pending: 0, blocked: 0, inProgress: 0 }
		}

		const phaseOptions = buildPhaseListOptions(ferment, { getTodoProgressForScope: resolver })
		const implementLine = phaseOptions.find((o) => o.includes("Implement"))
		const stepLines = buildPhaseStepOptions(ferment.phases[2], ferment.id, { getTodoProgressForScope: resolver })
		const implementStepLine = stepLines.find((l) => l.includes("Final wire-up"))

		expect(implementLine).toMatch(/todo 2\/3/)
		expect(implementLine).toMatch(/(1 pending)/)
		expect(implementStepLine).toContain("Final wire-up")
		expect(implementStepLine).not.toContain("todo")
	})

	it("adds tactical-work context in step detail with resolver counts", () => {
		const ferment = makeParallelFerment()
		const implement = ferment.phases.find((p) => p.name === "Implement")
		if (!implement) throw new Error("Implement phase missing")
		const step = implement.steps.find((s) => s.description === "Update token A")
		if (!step) throw new Error("Step missing")

		const title = buildStepDetailTitle(implement, step, ferment.id, {
			getTodoProgressForScope: () => ({ total: 5, completed: 3, pending: 2, blocked: 0, inProgress: 0 }),
		})

		expect(title).toContain("tactical work")
		expect(title).toMatch(/todo 3\/5/)
	})
})
