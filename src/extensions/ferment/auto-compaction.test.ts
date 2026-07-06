/**
 * Unit tests for auto-compaction logic.
 *
 * Tests:
 * 1. buildCustomInstructions  — custom instruction string building
 * 2. buildHandoffDetails       — FermentHandoffDetails payload shape
 * 3. maybeTriggerFermentCompaction — integration: no-op, trigger, onComplete, onError, in-flight guard
 */

import type { CompactionResult, ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { applyRoleAugmentation, resetModelRolesCache } from "../orchestration/model-roles.js"
import {
	buildCustomInstructions,
	buildHandoffDetails,
	buildMidTurnCustomInstructions,
	isToolCallInFlight,
	isToolCallInFlightInSession,
	maybeTriggerFermentCompaction,
	maybeTriggerMidTurnFermentCompaction,
} from "./auto-compaction.js"
import type { FermentRuntime } from "./runtime.js"
import { createDefaultFermentRuntime } from "./runtime.js"
import { clearPendingCompaction, type PendingCompaction, setPendingCompaction } from "./state.js"

// ─── Mock the dynamic require of engine.js in auto-compaction.ts ───────────────
// auto-compaction.ts uses require() inside buildNextActionDescription to avoid
// a circular dependency. Mock it here so tests run without the real engine.

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = "2026-01-01T00:00:00.000Z"
const STALE_CTX_MESSAGE = "This extension ctx is stale after session replacement or reload"

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
		sessionManager: {
			getEntries: vi.fn(() => []),
			appendCustomMessageEntry: vi.fn(),
		},
	} as unknown as ExtensionContext
}

type AppendCustomMessageEntryMock = ReturnType<typeof vi.fn>

function appendCustomMessageEntryMock(ctx: ExtensionContext): AppendCustomMessageEntryMock {
	return (
		ctx.sessionManager as unknown as {
			appendCustomMessageEntry: AppendCustomMessageEntryMock
		}
	).appendCustomMessageEntry
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

function makeSessionMessageEntry(message: unknown): SessionEntry {
	return {
		type: "message",
		id: `entry-${Math.random().toString(36).slice(2)}`,
		parentId: null,
		timestamp: NOW,
		message,
	} as unknown as SessionEntry
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
		resetModelRolesCache()
		vi.restoreAllMocks()
	})

	it("returns immediately when no ferment is active", async () => {
		runtime = makeRuntime({
			getStorage: () => mockStorage as unknown as import("../../ferment/event-store.js").FermentEventStore,
			getActiveId: () => undefined,
		})

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.compact).not.toHaveBeenCalled()
	})

	it("returns immediately when no pending compaction exists", async () => {
		runtime.setActive(makeFerment({ id: "ferment-1", name: "No Pending" }))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.compact).not.toHaveBeenCalled()
	})

	it("calls ctx.compact() with customInstructions when pending compaction exists and inlineCompact is unavailable", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.compact).toHaveBeenCalledTimes(1)
		const call = (ctx.compact as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			customInstructions: string
		}
		expect(call.customInstructions).toContain("Ferment: My Ferment")
		expect(call.customInstructions).toContain("Phase")
		expect(call.customInstructions).toContain("Do it")
	})

	it("keeps one-shot stage compaction disabled when inlineCompact is unavailable", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))
		pi.getFlag = vi.fn((name) => (name === "ferment-oneshot" ? true : undefined))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.compact).not.toHaveBeenCalled()
		expect(runtime.getPendingCompaction(ferment.id)).toBeDefined()
	})

	it("leaves pending compaction untouched when the one-shot flag read hits a stale pi", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))
		pi.getFlag = vi.fn(() => {
			throw new Error(STALE_CTX_MESSAGE)
		})

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.compact).not.toHaveBeenCalled()
		expect(runtime.getPendingCompaction(ferment.id)).toBeDefined()
	})

	it("appends the handoff before one-shot inline compaction and schedules continuation after", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))
		pi.getFlag = vi.fn((name) => (name === "ferment-oneshot" ? true : undefined))

		let resolveInline!: (result: CompactionResult) => void
		const inlineResult = new Promise<CompactionResult>((resolve) => {
			resolveInline = resolve
		})
		ctx.inlineCompact = vi.fn(() => {
			expect(appendCustomMessageEntryMock(ctx)).toHaveBeenCalledWith(
				"ferment_stage_handoff",
				expect.any(Array),
				false,
				expect.objectContaining({ fermentName: "My Ferment" }),
			)
			return inlineResult
		})

		const run = maybeTriggerFermentCompaction(pi, ctx, runtime)
		await Promise.resolve()

		expect(ctx.compact).not.toHaveBeenCalled()
		expect(ctx.inlineCompact).toHaveBeenCalledWith({
			customInstructions: expect.stringContaining("Ferment: My Ferment"),
			force: true,
			thinkingLevel: "off",
		})
		// The handoff must already be in the session while compaction runs: it is
		// the newest valid cut point, so the cut lands on it and the next stage
		// keeps summary + handoff.
		expect(appendCustomMessageEntryMock(ctx)).toHaveBeenCalledTimes(1)
		const [customType, content, display, details] = appendCustomMessageEntryMock(ctx).mock.calls[0]
		expect({ customType, content, display, details }).toMatchObject({
			customType: "ferment_stage_handoff",
			content: [{ type: "text", text: expect.stringContaining('"fermentName":"My Ferment"') }],
			display: false,
			details: { fermentName: "My Ferment", compactionTokensBefore: undefined },
		})
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(pi.appendEntry).not.toHaveBeenCalled()

		resolveInline({
			summary: "compacted ferment",
			firstKeptEntryId: "entry-1",
			tokensBefore: 123_456,
		})
		await run

		expect(pi.appendEntry).toHaveBeenCalledWith("ferment_breadcrumb", {
			text: expect.stringContaining("Stage compaction complete: 123,456 tokens"),
		})
		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		const nudgeCall = vi.mocked(pi.sendMessage).mock.calls[0]
		expect(nudgeCall[0]).toMatchObject({ customType: "ferment_continuation_nudge" })
		expect(nudgeCall[1]).toMatchObject({ triggerTurn: true, deliverAs: "steer" })
	})

	it("resolves modelRoles.compactor into ctx.inlineCompact's model option", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		applyRoleAugmentation((roles) => ({ ...roles, compactor: "kimchi-dev/non-reasoning-model" }))
		const compactorModel = { provider: "kimchi-dev", id: "non-reasoning-model" }
		const find = vi.fn(() => compactorModel)
		ctx.modelRegistry = { find } as unknown as ExtensionContext["modelRegistry"]
		ctx.inlineCompact = vi.fn(async () => ({
			summary: "compacted",
			firstKeptEntryId: "entry-1",
			tokensBefore: 10,
		}))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(find).toHaveBeenCalledWith("kimchi-dev", "non-reasoning-model")
		expect(ctx.inlineCompact).toHaveBeenCalledWith(
			expect.objectContaining({ model: compactorModel, force: true, thinkingLevel: "off" }),
		)
	})

	it("omits the model override when modelRoles.compactor is unset", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		// Force compactor unset regardless of the real ~/.config/kimchi/harness/settings.json
		// on the machine running this test — getModelRoles() reads that file directly
		// (same as judge.ts), so a locally configured compactor role would otherwise
		// leak into this "unset" scenario.
		applyRoleAugmentation((roles) => ({ ...roles, compactor: undefined }))

		const find = vi.fn()
		ctx.modelRegistry = { find } as unknown as ExtensionContext["modelRegistry"]
		ctx.inlineCompact = vi.fn(async () => ({
			summary: "compacted",
			firstKeptEntryId: "entry-1",
			tokensBefore: 10,
		}))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(find).not.toHaveBeenCalled()
		expect(ctx.inlineCompact).toHaveBeenCalledWith(
			expect.not.objectContaining({
				model: expect.anything(),
			}),
		)
	})

	it("warns when the compactor ref is configured but not in the registry", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		// Configured but not in the registry: silently compacting on the session
		// model forever is the diagnosability trap the warning exists for.
		applyRoleAugmentation((roles) => ({ ...roles, compactor: "kimchi-dev/typo-model" }))
		ctx.modelRegistry = { find: vi.fn(() => undefined) } as unknown as ExtensionContext["modelRegistry"]
		ctx.inlineCompact = vi.fn(async () => ({
			summary: "compacted",
			firstKeptEntryId: "entry-1",
			tokensBefore: 10,
		}))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(pi.appendEntry).toHaveBeenCalledWith("ferment_breadcrumb", {
			text: expect.stringContaining('Compactor model role "kimchi-dev/typo-model" is not in the model registry'),
		})
		// The fallback itself must be unaffected: compaction ran on the session model.
		const call = (ctx.inlineCompact as ReturnType<typeof vi.fn>).mock.calls[0][0] as { model?: unknown }
		expect(call.model).toBeUndefined()
	})

	it("warns when the compactor ref is not a valid provider/model reference", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		applyRoleAugmentation((roles) => ({ ...roles, compactor: "ref-without-provider-slash" }))
		ctx.inlineCompact = vi.fn(async () => ({
			summary: "compacted",
			firstKeptEntryId: "entry-1",
			tokensBefore: 10,
		}))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(pi.appendEntry).toHaveBeenCalledWith("ferment_breadcrumb", {
			text: expect.stringContaining("not a valid provider/model reference"),
		})
	})

	it("emits a loud breadcrumb when the synchronous handoff direct-append is unavailable", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		// Upstream renamed/removed appendCustomMessageEntry: the handoff degrades
		// to the async path, is not in the branch at prepare time, and the forced
		// compaction that expected it as a cut point can silently no-op. That
		// degradation must be visible in the session file, not just in a UI toast.
		ctx.sessionManager = { getEntries: vi.fn(() => []) } as unknown as ExtensionContext["sessionManager"]
		ctx.inlineCompact = vi.fn(async () => ({
			summary: "compacted",
			firstKeptEntryId: "entry-1",
			tokensBefore: 10,
		}))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(pi.appendEntry).toHaveBeenCalledWith("ferment_breadcrumb", {
			text: expect.stringContaining("direct-append unavailable"),
		})
		// The async fallback still delivers the handoff.
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_stage_handoff" }),
			expect.objectContaining({ triggerTurn: false }),
		)
	})

	it("appends a handoff without continuing when one-shot inline compaction is skipped", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))
		pi.getFlag = vi.fn((name) => (name === "ferment-oneshot" ? true : undefined))
		ctx.inlineCompact = vi.fn(async () => {
			throw new Error("Nothing to compact (session too small)")
		})

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.inlineCompact).toHaveBeenCalledWith({
			customInstructions: expect.stringContaining("Ferment: My Ferment"),
			force: true,
			thinkingLevel: "off",
		})
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		expect(runtime.isCompactionInFlight(ferment.id)).toBe(false)
		expect(appendCustomMessageEntryMock(ctx)).toHaveBeenCalledWith(
			"ferment_stage_handoff",
			expect.any(Array),
			false,
			expect.objectContaining({ fermentName: "My Ferment" }),
		)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		// The skip reason is persisted as a breadcrumb so headless runs stay
		// diagnosable from session files alone.
		expect(pi.appendEntry).toHaveBeenCalledWith("ferment_breadcrumb", {
			text: "Stage compaction skipped: Nothing to compact (session too small)",
		})
	})

	it("persists unexpected inline compaction failures as a breadcrumb and warns", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))
		pi.getFlag = vi.fn((name) => (name === "ferment-oneshot" ? true : undefined))
		ctx.inlineCompact = vi.fn(async () => {
			throw new Error("provider exploded")
		})

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		// Unexpected errors still warn via the UI when one exists…
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("provider exploded"), "warning")
		// …but the message must also land in a persisted breadcrumb so headless
		// runs (ui.notify is a no-op there) stay diagnosable from session files.
		expect(pi.appendEntry).toHaveBeenCalledWith("ferment_breadcrumb", {
			text: "Stage compaction skipped: provider exploded",
		})
		// The handoff was appended before the compaction attempt and no
		// continuation is scheduled without a saved summary.
		expect(appendCustomMessageEntryMock(ctx)).toHaveBeenCalledWith(
			"ferment_stage_handoff",
			expect.any(Array),
			false,
			expect.objectContaining({ fermentName: "My Ferment" }),
		)
		expect(pi.sendMessage).not.toHaveBeenCalled()
		expect(runtime.isCompactionInFlight(ferment.id)).toBe(false)
	})

	it("clears pending compaction after triggering", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Step" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(runtime.getPendingCompaction(ferment.id)).toBeUndefined()
	})

	it("onComplete calls pi.sendMessage with ferment_stage_handoff and display: false", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Step" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

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
		expect(sendMsgCalls[1][1]).toMatchObject({ triggerTurn: true, deliverAs: "steer" })
	})

	it("onError calls ctx.ui.notify with a warning and does not throw", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Step" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

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

	it("in-flight guard: a new pending while compaction is running is left for the next tick", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Step" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		// First call — starts compaction, marks ferment in-flight.
		await maybeTriggerFermentCompaction(pi, ctx, runtime)
		expect(ctx.compact).toHaveBeenCalledTimes(1)

		// A new pending arrives while the first compaction is still running
		// (onComplete has NOT been called yet, so in-flight flag is still set).
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-2"))

		// Second call — ferment is in-flight so drainPendingCompactions skips it;
		// no additional compact() call is made.
		await maybeTriggerFermentCompaction(pi, ctx, runtime)
		expect(ctx.compact).toHaveBeenCalledTimes(1)

		// After onComplete fires, the in-flight flag is cleared.
		const compactCall = (ctx.compact as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			onComplete: (result: CompactionResult) => void
		}
		compactCall.onComplete({ tokensBefore: 1000 } as unknown as CompactionResult)

		// Now step-2 pending is still in the map and will fire on the next tick.
		await maybeTriggerFermentCompaction(pi, ctx, runtime)
		expect(ctx.compact).toHaveBeenCalledTimes(2)
	})

	it("returns early when ferment is not found in storage after reload", async () => {
		runtime = makeRuntime({
			getStorage: () => mockStorage as unknown as import("../../ferment/event-store.js").FermentEventStore,
			getActiveId: () => "missing-ferment-id",
		})
		// Inject a pending compaction for a non-existent ferment
		setPendingCompaction("missing-ferment-id", makePendingStep("missing-ferment-id", "phase-1", "step-1"))

		await expect(maybeTriggerFermentCompaction(pi, ctx, runtime)).resolves.toBe(false)
		expect(ctx.compact).not.toHaveBeenCalled()
	})
})

describe("buildMidTurnCustomInstructions", () => {
	it("includes ferment name, goal, and success criteria", () => {
		const ferment = makeFerment({ name: "Test Ferment", goal: "Test the thing" })
		const phase = makePhase({ id: "phase-1", name: "Implementation", goal: "Write code" })
		const step = makeStep({ id: "step-1", description: "Write tests" })

		const instructions = buildMidTurnCustomInstructions(ferment, phase, step)

		expect(instructions).toContain("Test Ferment")
		expect(instructions).toContain("Test the thing")
		expect(instructions).toContain("Tests pass")
		expect(instructions).toContain("Lint clean")
	})

	it("includes active phase and in-progress step", () => {
		const ferment = makeFerment()
		const phase = makePhase({ id: "phase-1", name: "Implementation", goal: "Write code" })
		const step = makeStep({ id: "step-1", description: "Write tests" })

		const instructions = buildMidTurnCustomInstructions(ferment, phase, step)

		expect(instructions).toContain("Implementation")
		expect(instructions).toContain("Write code")
		expect(instructions).toContain("Write tests")
		expect(instructions).toContain("continue the in-progress step")
	})
})

describe("maybeTriggerMidTurnFermentCompaction", () => {
	const CONTEXT_WINDOW = 100_000

	function makeMidTurnRuntime(ferment: Ferment): FermentRuntime {
		const runtime = makeRuntime()
		runtime.getActive = vi.fn(() => ferment)
		runtime.getStorage = vi.fn(
			() => makeMockStorage(new Map([[ferment.id, ferment]])) as unknown as ReturnType<typeof runtime.getStorage>,
		)
		return runtime
	}

	function makeMidTurnCtx(): ExtensionContext {
		return {
			...makeCtx(),
			model: { contextWindow: CONTEXT_WINDOW },
		} as unknown as ExtensionContext
	}

	it("no-ops when total tokens are below the threshold", () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		const pi = makePi()
		const ctx = makeMidTurnCtx()

		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, 1000)

		expect(ctx.compact).not.toHaveBeenCalled()
	})

	it("compacts and schedules resume when the threshold is exceeded with an active step", () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		const pi = makePi()
		const ctx = makeMidTurnCtx()

		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)

		expect(ctx.compact).toHaveBeenCalledOnce()

		const compactArgs = vi.mocked(ctx.compact).mock.calls[0]?.[0]
		expect(compactArgs).toBeDefined()
		compactArgs?.onComplete?.({ summary: "", firstKeptEntryId: "", tokensBefore: 99_000 })

		expect(pi.appendEntry).toHaveBeenCalledWith(
			"ferment_breadcrumb",
			expect.objectContaining({
				text: expect.stringContaining("Mid-turn compaction resume"),
			}),
		)
	})

	it("no-ops when no ferment is active", () => {
		const runtime = makeRuntime()
		runtime.getActive = vi.fn(() => undefined)
		const pi = makePi()
		const ctx = makeMidTurnCtx()

		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)

		expect(ctx.compact).not.toHaveBeenCalled()
	})

	it("no-ops when no step is in progress", () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "done"
		const runtime = makeMidTurnRuntime(ferment)
		const pi = makePi()
		const ctx = makeMidTurnCtx()

		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)

		expect(ctx.compact).not.toHaveBeenCalled()
	})

	it("no-ops when a compaction is already in-flight", () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		runtime.markCompactionInFlight(ferment.id)
		const pi = makePi()
		const ctx = makeMidTurnCtx()

		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)

		expect(ctx.compact).not.toHaveBeenCalled()
	})

	it("no-ops in oneshot mode and emits a single planning-failure breadcrumb", () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		const pi = makePi()
		pi.getFlag = vi.fn((name) => (name === "ferment-oneshot" ? true : undefined))
		const ctx = makeMidTurnCtx()

		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)
		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)

		expect(ctx.compact).not.toHaveBeenCalled()
		expect(pi.appendEntry).toHaveBeenCalledTimes(1)
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"ferment_breadcrumb",
			expect.objectContaining({
				text: expect.stringContaining("Mid-turn context overrun in oneshot"),
			}),
		)
	})

	it("no-ops when the one-shot flag read hits a stale pi", () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		const pi = makePi()
		pi.getFlag = vi.fn(() => {
			throw new Error(STALE_CTX_MESSAGE)
		})
		const ctx = makeMidTurnCtx()

		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)

		expect(ctx.compact).not.toHaveBeenCalled()
		expect(pi.appendEntry).not.toHaveBeenCalled()
	})

	it("onError with an expected error clears in-flight without notifying", () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		runtime.clearCompactionInFlight(ferment.id)
		const pi = makePi()
		const ctx = makeMidTurnCtx()

		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)
		expect(runtime.isCompactionInFlight(ferment.id)).toBe(true)

		const compactArgs = vi.mocked(ctx.compact).mock.calls[0]?.[0]
		compactArgs?.onError?.(new Error("Compaction cancelled"))

		expect(runtime.isCompactionInFlight(ferment.id)).toBe(false)
		expect(ctx.ui?.notify).not.toHaveBeenCalled()
	})

	it("onError with an unexpected error clears in-flight and notifies", () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		runtime.clearCompactionInFlight(ferment.id)
		const pi = makePi()
		const ctx = makeMidTurnCtx()

		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)
		const compactArgs = vi.mocked(ctx.compact).mock.calls[0]?.[0]
		compactArgs?.onError?.(new Error("disk full"))

		expect(runtime.isCompactionInFlight(ferment.id)).toBe(false)
		expect(ctx.ui?.notify).toHaveBeenCalledWith(expect.stringContaining("disk full"), "warning")
	})

	it("clears in-flight and notifies when ctx.compact throws synchronously", () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		runtime.clearCompactionInFlight(ferment.id)
		const pi = makePi()
		const ctx = makeMidTurnCtx()
		ctx.compact = vi.fn(() => {
			throw new Error("sync compact failure")
		})

		expect(() => maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)).not.toThrow()
		expect(runtime.isCompactionInFlight(ferment.id)).toBe(false)
		expect(ctx.ui?.notify).toHaveBeenCalledWith(expect.stringContaining("sync compact failure"), "warning")
	})
})

describe("in-flight tool-call guard", () => {
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
		clearPendingCompaction("ferment-1")
		vi.restoreAllMocks()
	})

	describe("isToolCallInFlight", () => {
		it("returns true when a toolCall has no matching toolResult", () => {
			const messages = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1" }],
				},
			]
			expect(isToolCallInFlight(messages)).toBe(true)
		})

		it("returns false when the matching toolResult is present", () => {
			const messages = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1" }],
				},
				{ role: "toolResult", toolCallId: "call-1" },
			]
			expect(isToolCallInFlight(messages)).toBe(false)
		})

		it("returns false for empty arrays and messages with no tool calls", () => {
			expect(isToolCallInFlight([])).toBe(false)
			expect(isToolCallInFlight([{ role: "user", content: "hi" }])).toBe(false)
			expect(isToolCallInFlight([{ role: "assistant", content: [{ type: "text" }] }])).toBe(false)
		})

		it("returns true when only some toolCalls have matching toolResults", () => {
			const messages = [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1" },
						{ type: "toolCall", id: "call-2" },
					],
				},
				{ role: "toolResult", toolCallId: "call-1" },
			]
			expect(isToolCallInFlight(messages)).toBe(true)
		})

		it("returns false for malformed input without throwing", () => {
			const malformed = [null, { role: "user" }, { role: "assistant", content: "not-an-array" }]
			expect(() => isToolCallInFlight(malformed)).not.toThrow()
			expect(isToolCallInFlight(malformed)).toBe(false)
		})
	})

	describe("isToolCallInFlightInSession", () => {
		it("returns true when the session contains an in-flight toolCall", () => {
			ctx.sessionManager.getEntries = vi.fn(() => [
				makeSessionMessageEntry({
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1" }],
				}),
			])
			expect(isToolCallInFlightInSession(ctx)).toBe(true)
		})

		it("returns false when the session has a completed toolCall pair", () => {
			ctx.sessionManager.getEntries = vi.fn(() => [
				makeSessionMessageEntry({
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1" }],
				}),
				makeSessionMessageEntry({ role: "toolResult", toolCallId: "call-1" }),
			])
			expect(isToolCallInFlightInSession(ctx)).toBe(false)
		})

		it("returns false when sessionManager is unavailable", () => {
			const ctxWithoutSessionManager = { ...makeCtx(), sessionManager: undefined } as unknown as ExtensionContext
			expect(isToolCallInFlightInSession(ctxWithoutSessionManager)).toBe(false)
		})
	})

	describe("maybeTriggerFermentCompaction", () => {
		it("does not compact while a toolCall is in flight", async () => {
			const ferment = makeFermentWithPhase(
				{ id: "phase-1", name: "Phase", goal: "Goal" },
				{ id: "step-1", description: "Step" },
			)
			storageMap.set(ferment.id, ferment)
			runtime.setActive(ferment)
			setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

			ctx.sessionManager.getEntries = vi.fn(() => [
				makeSessionMessageEntry({
					role: "assistant",
					content: [{ type: "toolCall", id: "call-in-flight" }],
				}),
			])

			await maybeTriggerFermentCompaction(pi, ctx, runtime)

			expect(ctx.compact).not.toHaveBeenCalled()
			expect(runtime.getPendingCompaction(ferment.id)).toBeDefined()
		})

		it("compacts normally once the matching toolResult lands", async () => {
			const ferment = makeFermentWithPhase(
				{ id: "phase-1", name: "Phase", goal: "Goal" },
				{ id: "step-1", description: "Step" },
			)
			storageMap.set(ferment.id, ferment)
			runtime.setActive(ferment)
			setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

			ctx.sessionManager.getEntries = vi.fn(() => [
				makeSessionMessageEntry({
					role: "assistant",
					content: [{ type: "toolCall", id: "call-done" }],
				}),
				makeSessionMessageEntry({ role: "toolResult", toolCallId: "call-done" }),
			])

			await maybeTriggerFermentCompaction(pi, ctx, runtime)

			expect(ctx.compact).toHaveBeenCalledOnce()
			expect(runtime.getPendingCompaction(ferment.id)).toBeUndefined()
		})
	})
})
