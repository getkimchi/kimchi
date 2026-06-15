/**
 * Unit tests for auto-compaction logic.
 *
 * Tests:
 * 1. buildCustomInstructions  — custom instruction string building
 * 2. buildHandoffDetails       — FermentHandoffDetails payload shape
 * 3. maybeTriggerFermentCompaction — integration: no-op, trigger, onComplete, onError, in-flight guard
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import type { CompactionResult } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { buildCustomInstructions, buildHandoffDetails, maybeTriggerFermentCompaction } from "./auto-compaction.js"
import type { FermentRuntime } from "./runtime.js"
import { createDefaultFermentRuntime } from "./runtime.js"
import { type PendingCompaction, clearPendingCompaction, setPendingCompaction } from "./state.js"

// ─── Mock the dynamic require of engine.js in auto-compaction.ts ───────────────
// auto-compaction.ts uses require() inside buildNextActionDescription to avoid
// a circular dependency. Mock it here so tests run without the real engine.

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z"

function makeStep(overrides: Partial<Step> & { id: string; description: string }): Step {
	return {
		index: 1,
		status: "done",
		...overrides,
	}
}

function makePhase(overrides: Partial<Phase> & { id: string; name: string; goal: string }): Phase {
	return {
		index: 1,
		status: "active",
		steps: [],
		...overrides,
	}
}

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-1",
		name: "My Ferment",
		status: "running",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: NOW,
		updatedAt: NOW,
		goal: "Ship the feature",
		successCriteria: ["Tests pass", "Lint clean"],
		...overrides,
	}
}

function makePi(): ExtensionAPI {
	return {
		on: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerTool: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
	} as unknown as ExtensionAPI
}

function makeCtx(): ExtensionContext {
	return {
		compact: vi.fn(),
		ui: {
			notify: vi.fn(),
		},
	} as unknown as ExtensionContext
}

// Simple in-memory storage for maybeTriggerFermentCompaction tests.
// Simulates FermentEventStore for get() / list() / save() / delete() / resolve().
function makeMockStorage(ferments: Map<string, Ferment> = new Map()) {
	const map = ferments
	return {
		get: vi.fn((id: string) => map.get(id)),
		list: vi.fn(() => [...map.values()]),
		save: vi.fn(),
		write: vi.fn(),
		addDecision: vi.fn(),
		addMemory: vi.fn(),
		updateWorktree: vi.fn(),
		isFullyTerminal: vi.fn(),
		delete: vi.fn(),
		resolve: vi.fn(),
		apply: vi.fn(),
	}
}

function makeRuntime(overrides: Partial<FermentRuntime> = {}): FermentRuntime {
	const base = createDefaultFermentRuntime()
	return {
		...base,
		...overrides,
	} as FermentRuntime
}

// ─── Test data factory helpers ────────────────────────────────────────────────

function makeFermentWithPhase(
	phaseOverrides: Partial<Phase> & { id: string; name: string; goal: string } = {
		id: "phase-1",
		name: "Phase One",
		goal: "Build stuff",
	},
	stepOverrides: Partial<Step> & { id: string; description: string } = {
		id: "step-1",
		description: "Do the thing",
	},
): Ferment {
	return makeFerment({
		phases: [
			{
				...makePhase({ ...phaseOverrides, steps: [makeStep(stepOverrides)] }),
			},
		],
	})
}

function makePendingStep(fermentId = "ferment-1", phaseId = "phase-1", stepId = "step-1"): PendingCompaction {
	return { kind: "step", fermentId, phaseId, stepId, completedAt: NOW }
}

function makePendingPhase(fermentId = "ferment-1", phaseId = "phase-1"): PendingCompaction {
	return { kind: "phase", fermentId, phaseId, completedAt: NOW }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("buildCustomInstructions", () => {
	it("includes ferment name and goal", () => {
		const ferment = makeFerment({ name: "Test Ferment", goal: "Test the thing" })
		const pending = makePendingPhase()

		const instructions = buildCustomInstructions(ferment, pending)

		expect(instructions).toContain("Test Ferment")
		expect(instructions).toContain("Test the thing")
	})

	it("includes success criteria", () => {
		const ferment = makeFerment({
			successCriteria: ["Criterion A", "Criterion B"],
		})
		const pending = makePendingPhase()

		const instructions = buildCustomInstructions(ferment, pending)

		expect(instructions).toContain("Success criteria: Criterion A; Criterion B")
	})

	it("includes active phase name and goal", () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Implementation", goal: "Write code" },
			{ id: "step-1", description: "Write tests" },
		)
		ferment.phases[0].status = "active"
		const pending = makePendingPhase("ferment-1", "phase-1")

		const instructions = buildCustomInstructions(ferment, pending)

		expect(instructions).toContain("Implementation")
		expect(instructions).toContain("Write code")
	})

	it("includes completed step description and summary for step-kind pending", () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Write the feature", summary: "Done" },
		)
		ferment.phases[0].status = "active"
		const pending = makePendingStep("ferment-1", "phase-1", "step-1")

		const instructions = buildCustomInstructions(ferment, pending)

		expect(instructions).toContain("Write the feature")
		expect(instructions).toContain("Done")
	})

	it("includes completed phase summary for phase-kind pending", () => {
		const ferment = makeFermentWithPhase(
			{
				id: "phase-1",
				name: "Phase One",
				goal: "Goal",
				summary: "Phase completed successfully",
			},
			{ id: "step-1", description: "Do it" },
		)
		const pending = makePendingPhase("ferment-1", "phase-1")

		const instructions = buildCustomInstructions(ferment, pending)

		expect(instructions).toContain("Phase One")
		expect(instructions).toContain("Phase completed successfully")
	})

	it("includes next step description when a next step is available", () => {
		const ferment = makeFerment({
			phases: [
				makePhase({
					id: "phase-1",
					name: "Phase One",
					goal: "First goal",
					status: "completed",
					steps: [
						makeStep({
							id: "step-1",
							description: "Done step",
							status: "done",
						}),
					],
				}),
				makePhase({
					id: "phase-2",
					name: "Phase Two",
					goal: "Second goal",
					status: "active",
					steps: [
						makeStep({
							id: "step-2",
							description: "Next step",
							index: 2,
							status: "pending",
						}),
					],
				}),
			],
		})
		const pending = makePendingPhase("ferment-1", "phase-1")

		const instructions = buildCustomInstructions(ferment, pending)

		expect(instructions).toContain("Step 2:")
		expect(instructions).toContain("Next step")
	})

	it("marks ferment as terminal when no next action exists", () => {
		const ferment = makeFerment({
			status: "running",
			phases: [
				makePhase({
					id: "phase-1",
					name: "Phase One",
					goal: "Goal",
					status: "completed",
					steps: [makeStep({ id: "step-1", description: "Done", status: "done" })],
				}),
			],
		})
		const pending = makePendingPhase("ferment-1", "phase-1")

		const instructions = buildCustomInstructions(ferment, pending)

		expect(instructions).toContain("No further lifecycle action")
	})
})

describe("buildHandoffDetails", () => {
	it("populates ferment name, goal, and success criteria", () => {
		const ferment = makeFerment({
			name: "Handoff Ferment",
			goal: "Achieve X",
			successCriteria: ["A", "B"],
		})
		const result = { tokensBefore: 5000 } as unknown as CompactionResult
		const pending = makePendingPhase()

		const details = buildHandoffDetails(result, ferment, pending)

		expect(details.fermentName).toBe("Handoff Ferment")
		expect(details.fermentGoal).toBe("Achieve X")
		expect(details.successCriteria).toEqual(["A", "B"])
	})

	it("populates active phase name and goal", () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Active Phase", goal: "Active goal" },
			{ id: "step-1", description: "Step" },
		)
		ferment.phases[0].status = "active"
		const result = {} as CompactionResult
		const pending = makePendingPhase("ferment-1", "phase-1")

		const details = buildHandoffDetails(result, ferment, pending)

		expect(details.activePhaseName).toBe("Active Phase")
		expect(details.activePhaseGoal).toBe("Active goal")
	})

	it("populates completedStepSummary when step kind", () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "The step", summary: "Step summary" },
		)
		ferment.phases[0].status = "active"
		const result = {} as CompactionResult
		const pending = makePendingStep("ferment-1", "phase-1", "step-1")

		const details = buildHandoffDetails(result, ferment, pending)

		expect(details.completedStepSummary).toBe("Step summary")
		expect(details.completedPhaseSummary).toBeUndefined()
	})

	it("populates completedPhaseSummary when phase kind", () => {
		const ferment = makeFermentWithPhase(
			{
				id: "phase-1",
				name: "Phase",
				goal: "Goal",
				summary: "Phase summary",
			},
			{ id: "step-1", description: "Step" },
		)
		const result = {} as CompactionResult
		const pending = makePendingPhase("ferment-1", "phase-1")

		const details = buildHandoffDetails(result, ferment, pending)

		expect(details.completedPhaseSummary).toBe("Phase summary")
		expect(details.completedStepSummary).toBeUndefined()
	})

	it("sets compactionTokensBefore from CompactionResult.tokensBefore", () => {
		const ferment = makeFerment()
		const result = { tokensBefore: 12345 } as unknown as CompactionResult
		const pending = makePendingPhase()

		const details = buildHandoffDetails(result, ferment, pending)

		expect(details.compactionTokensBefore).toBe(12345)
	})

	it("populates next step/phase details", () => {
		const ferment = makeFerment({
			phases: [
				makePhase({
					id: "phase-1",
					name: "Phase One",
					goal: "First",
					status: "completed",
					steps: [makeStep({ id: "step-1", description: "Done", status: "done" })],
				}),
				makePhase({
					id: "phase-2",
					name: "Phase Two",
					goal: "Second",
					status: "active",
					steps: [makeStep({ id: "step-2", description: "Next", status: "pending", index: 2 })],
				}),
			],
		})
		const result = {} as CompactionResult
		const pending = makePendingPhase("ferment-1", "phase-1")

		const details = buildHandoffDetails(result, ferment, pending)

		expect(details.nextPhaseName).toBe("Phase Two")
		expect(details.nextPhaseGoal).toBe("Second")
		expect(details.nextStepDescription).toContain("Step 2")
	})
})

describe("maybeTriggerFermentCompaction", () => {
	let storageMap: Map<string, Ferment>
	let mockStorage: ReturnType<typeof makeMockStorage>
	let runtime: FermentRuntime
	let pi: ExtensionAPI
	let ctx: ExtensionContext

	beforeEach(() => {
		storageMap = new Map()
		mockStorage = makeMockStorage(storageMap)
		runtime = makeRuntime({
			getStorage: () => mockStorage as unknown as import("../../ferment/event-store.js").FermentEventStore,
		})
		pi = makePi()
		ctx = makeCtx()
	})

	afterEach(() => {
		runtime.clearCompactionInFlight("ferment-1")
		runtime.clearCompactionInFlight("ferment-2")
		clearPendingCompaction("ferment-1")
		clearPendingCompaction("ferment-2")
		vi.restoreAllMocks()
	})

	it("returns immediately when no ferment is active", () => {
		runtime = makeRuntime({
			getStorage: () => mockStorage as unknown as import("../../ferment/event-store.js").FermentEventStore,
			getActiveId: () => undefined,
		})

		maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.compact).not.toHaveBeenCalled()
	})

	it("returns immediately when no pending compaction exists", () => {
		runtime.setActive(makeFerment({ id: "ferment-1", name: "No Pending" }))

		maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.compact).not.toHaveBeenCalled()
	})

	it("calls ctx.compact() with customInstructions when pending compaction exists", () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.compact).toHaveBeenCalledTimes(1)
		const call = (ctx.compact as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			customInstructions: string
		}
		expect(call.customInstructions).toContain("Ferment: My Ferment")
		expect(call.customInstructions).toContain("Phase")
		expect(call.customInstructions).toContain("Do it")
	})

	it("clears pending compaction after triggering", () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Step" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(runtime.getPendingCompaction(ferment.id)).toBeUndefined()
	})

	it("onComplete calls pi.sendMessage with ferment_stage_handoff and display: false", () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Step" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		maybeTriggerFermentCompaction(pi, ctx, runtime)

		const compactCall = (ctx.compact as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			onComplete: (result: CompactionResult) => void
			onError: (error: Error) => void
		}

		const fakeResult = { tokensBefore: 5000 } as unknown as CompactionResult
		compactCall.onComplete(fakeResult)

		// onComplete should fire two sendMessage calls: handoff entry, then
		// continuation nudge so the agent keeps moving.
		expect(pi.sendMessage).toHaveBeenCalledTimes(2)
		const sendMsgCalls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls
		expect(sendMsgCalls[0][0]).toMatchObject({
			customType: "ferment_stage_handoff",
			display: false,
		})
		expect(sendMsgCalls[0][0].details).toMatchObject({
			fermentName: "My Ferment",
			compactionTokensBefore: 5000,
		})
		expect(sendMsgCalls[1][0]).toMatchObject({
			customType: "ferment_continuation_nudge",
		})
		expect(sendMsgCalls[1][1]).toMatchObject({ triggerTurn: true })
	})

	it("onError calls ctx.ui.notify with a warning and does not throw", () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Step" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		maybeTriggerFermentCompaction(pi, ctx, runtime)

		const compactCall = (ctx.compact as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			onComplete: (result: CompactionResult) => void
			onError: (error: Error) => void
		}

		expect(() => compactCall.onError(new Error("compaction failed"))).not.toThrow()
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		const notifyCall = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(notifyCall[0]).toContain("compaction failed")
		expect(notifyCall[1]).toBe("warning")
	})

	it("in-flight guard: a new pending while compaction is running is left for the next tick", () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Step" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		// First call — starts compaction, marks ferment in-flight.
		maybeTriggerFermentCompaction(pi, ctx, runtime)
		expect(ctx.compact).toHaveBeenCalledTimes(1)

		// A new pending arrives while the first compaction is still running
		// (onComplete has NOT been called yet, so in-flight flag is still set).
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-2"))

		// Second call — ferment is in-flight so drainPendingCompactions skips it;
		// no additional compact() call is made.
		maybeTriggerFermentCompaction(pi, ctx, runtime)
		expect(ctx.compact).toHaveBeenCalledTimes(1)

		// After onComplete fires, the in-flight flag is cleared.
		const compactCall = (ctx.compact as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			onComplete: (result: CompactionResult) => void
		}
		compactCall.onComplete({ tokensBefore: 1000 } as unknown as CompactionResult)

		// Now step-2 pending is still in the map and will fire on the next tick.
		maybeTriggerFermentCompaction(pi, ctx, runtime)
		expect(ctx.compact).toHaveBeenCalledTimes(2)
	})

	it("returns early when ferment is not found in storage after reload", () => {
		runtime = makeRuntime({
			getStorage: () => mockStorage as unknown as import("../../ferment/event-store.js").FermentEventStore,
			getActiveId: () => "missing-ferment-id",
		})
		// Inject a pending compaction for a non-existent ferment
		setPendingCompaction("missing-ferment-id", makePendingStep("missing-ferment-id", "phase-1", "step-1"))

		expect(() => maybeTriggerFermentCompaction(pi, ctx, runtime)).not.toThrow()
		expect(ctx.compact).not.toHaveBeenCalled()
	})
})
