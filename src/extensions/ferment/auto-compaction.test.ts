/**
 * Unit tests for auto-compaction logic.
 *
 * Tests:
 * 1. buildCustomInstructions  — custom instruction string building
 * 2. buildHandoffDetails       — FermentHandoffDetails payload shape
 * 3. maybeTriggerFermentCompaction — integration: no-op, trigger, onComplete, onError, in-flight guard
 */

import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai"
import {
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment, Phase, Step } from "../../ferment/types.js"
import { getCompactionEnabled } from "../../settings-watcher.js"
import { applyRoleAugmentation, resetModelRolesCache } from "../orchestration/model-roles.js"
import {
	buildCustomInstructions,
	buildHandoffDetails,
	buildMidTurnCustomInstructions,
	DEFAULT_STAGE_COMPACTION_OPTIONS,
	isToolCallInFlight,
	isToolCallInFlightInSession,
	maybeTriggerFermentCompaction,
	maybeTriggerMidTurnFermentCompaction,
} from "./auto-compaction.js"
import type { FermentRuntime } from "./runtime.js"
import { createDefaultFermentRuntime } from "./runtime.js"
import { clearPendingCompaction, type PendingCompaction, setPendingCompaction } from "./state.js"

// Mock the settings-watcher so the /settings Auto-compact toggle can be
// controlled per-test. Default factory returns `true` so every existing test
// keeps passing unchanged (backward compatible).
vi.mock("../../settings-watcher.js", () => ({
	getCompactionEnabled: vi.fn(() => true),
}))

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

/** An assistant message whose usage reports `totalTokens` — the signal the
 *  stage-compaction minimum-size gate reads. Shaped like a kimchi-dev
 *  open-weight model response (openai-completions API), matching how
 *  `src/models.ts` wires the kimchi-dev provider. */
function makeAssistantMessage(totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "kimchi-dev",
		model: "kimi-k2.7",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

// Context sizes relative to the stage-compaction minimum-size gate, derived
// from the real constant so a future gate change cannot silently flip tests
// onto the skip path. makeCtx sessions default to above-gate so tests
// exercising the compaction path are not skipped.
const ABOVE_GATE_TOKENS = DEFAULT_STAGE_COMPACTION_OPTIONS.minContextTokens + 10_000
const BELOW_GATE_TOKENS = DEFAULT_STAGE_COMPACTION_OPTIONS.minContextTokens - 20_000

/** Build a ctx backed by a real in-memory pi SessionManager, seeded with one
 *  assistant message reporting `contextTokens` (0 seeds nothing). */
function makeCtx(contextTokens: number = ABOVE_GATE_TOKENS): ExtensionContext {
	const sessionManager = SessionManager.inMemory()
	if (contextTokens > 0) {
		sessionManager.appendMessage(makeAssistantMessage(contextTokens))
	}
	vi.spyOn(sessionManager, "appendCustomMessageEntry")
	return {
		compact: vi.fn(),
		ui: {
			notify: vi.fn(),
		},
		sessionManager,
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

function setSessionEntries(ctx: ExtensionContext, entries: SessionEntry[]): void {
	const linkedEntries = entries.map((entry, index) => ({
		...entry,
		parentId: index === 0 ? null : entries[index - 1].id,
	})) as SessionEntry[]
	ctx.sessionManager.getEntries = vi.fn(() => linkedEntries)
	ctx.sessionManager.getLeafId = vi.fn(() => linkedEntries.at(-1)?.id ?? null)
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
		ctx.model = { contextWindow: 100_000 } as ExtensionContext["model"]

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
		ctx.modelRegistry = {
			find: vi.fn((provider: string, modelId: string) =>
				provider === "kimchi-dev" && modelId === "minimax-m3" ? { provider, id: modelId } : undefined,
			),
		} as unknown as ExtensionContext["modelRegistry"]

		const run = maybeTriggerFermentCompaction(pi, ctx, runtime)
		await Promise.resolve()

		expect(ctx.compact).not.toHaveBeenCalled()
		expect(ctx.inlineCompact).toHaveBeenCalledWith(
			expect.objectContaining({
				customInstructions: expect.stringContaining("Ferment: My Ferment"),
				force: true,
				// 5% of the 100k window is 5k — clamped up to the 20k floor.
				keepRecentTokens: 20_000,
				model: { provider: "kimchi-dev", id: "minimax-m3" },
				thinkingLevel: "off",
			}),
		)
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
		const bareSession = SessionManager.inMemory()
		bareSession.appendMessage(makeAssistantMessage(ABOVE_GATE_TOKENS))
		ctx.sessionManager = {
			getEntries: () => bareSession.getEntries(),
		} as unknown as ExtensionContext["sessionManager"]
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
			// No ctx.model → 5% of window is 0 — clamped up to the 20k floor.
			keepRecentTokens: 20_000,
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

	it("skips inline compaction below the minimum-size gate but still delivers the handoff", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))
		pi.getFlag = vi.fn((name) => (name === "ferment-oneshot" ? true : undefined))
		ctx = makeCtx(BELOW_GATE_TOKENS)
		ctx.inlineCompact = vi.fn()

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.inlineCompact).not.toHaveBeenCalled()
		expect(ctx.compact).not.toHaveBeenCalled()
		// The pending entry is consumed — the next stage boundary re-checks.
		expect(runtime.getPendingCompaction(ferment.id)).toBeUndefined()
		expect(runtime.isCompactionInFlight(ferment.id)).toBe(false)
		// The handoff still reaches the next stage, carrying the skip reason.
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_stage_handoff",
				details: expect.objectContaining({
					compactionError: expect.stringContaining(
						`below the ${DEFAULT_STAGE_COMPACTION_OPTIONS.minContextTokens.toLocaleString()}-token stage-compaction minimum`,
					),
				}),
			}),
			expect.objectContaining({ triggerTurn: false }),
		)
		expect(pi.appendEntry).toHaveBeenCalledWith("ferment_breadcrumb", {
			text: expect.stringContaining(`Stage compaction skipped: context ~${BELOW_GATE_TOKENS.toLocaleString()} tokens`),
		})
	})

	it("treats a session with no assistant usage as below the minimum-size gate", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))
		ctx = makeCtx(0)
		ctx.inlineCompact = vi.fn()

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.inlineCompact).not.toHaveBeenCalled()
		expect(runtime.isCompactionInFlight(ferment.id)).toBe(false)
	})

	it("honours caller-supplied stage-compaction options", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))
		applyRoleAugmentation((roles) => ({ ...roles, compactor: undefined }))
		// 30k context: below the default 50k gate, above the custom 10k one.
		ctx = makeCtx(30_000)
		ctx.model = { contextWindow: 100_000 } as ExtensionContext["model"]
		ctx.inlineCompact = vi.fn(async () => ({
			summary: "compacted",
			firstKeptEntryId: "entry-1",
			tokensBefore: 30_000,
		}))

		await maybeTriggerFermentCompaction(pi, ctx, runtime, {
			minContextTokens: 10_000,
			minKeepRecentTokens: 1_000,
			keepRecentWindowFraction: 0.5,
			thinkingLevel: "low",
		})

		expect(ctx.inlineCompact).toHaveBeenCalledWith(
			expect.objectContaining({
				// max(1k floor, 50% of the 100k window)
				keepRecentTokens: 50_000,
				thinkingLevel: "low",
			}),
		)
	})

	it("keeps 5% of large context windows when that exceeds the 20k keep-recent floor", async () => {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))
		applyRoleAugmentation((roles) => ({ ...roles, compactor: undefined }))
		ctx.model = { contextWindow: 1_000_000 } as ExtensionContext["model"]
		ctx.inlineCompact = vi.fn(async () => ({
			summary: "compacted",
			firstKeptEntryId: "entry-1",
			tokensBefore: 100_000,
		}))

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.inlineCompact).toHaveBeenCalledWith(expect.objectContaining({ keepRecentTokens: 50_000 }))
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

	it("prefers ctx.inlineCompact over ctx.compact and schedules resume on success", async () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		const pi = makePi()
		const ctx = makeMidTurnCtx()
		ctx.inlineCompact = vi.fn(async () => ({
			summary: "compacted",
			firstKeptEntryId: "entry-1",
			tokensBefore: 88_000,
		}))

		await maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)

		expect(ctx.compact).not.toHaveBeenCalled()
		expect(ctx.inlineCompact).toHaveBeenCalledWith(
			expect.objectContaining({
				customInstructions: expect.stringContaining("In-progress step"),
				force: true,
				// 5% of the 100k window is 5k — clamped up to the 20k floor.
				keepRecentTokens: 20_000,
				thinkingLevel: "off",
			}),
		)
		expect(runtime.isCompactionInFlight(ferment.id)).toBe(false)
		expect(pi.appendEntry).toHaveBeenCalledWith(
			"ferment_breadcrumb",
			expect.objectContaining({ text: expect.stringContaining("Mid-turn compaction resume") }),
		)
	})

	it("clears in-flight and notifies when inlineCompact rejects with an unexpected error", async () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		const pi = makePi()
		const ctx = makeMidTurnCtx()
		ctx.inlineCompact = vi.fn(async () => {
			throw new Error("disk full")
		})

		await maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)

		expect(ctx.compact).not.toHaveBeenCalled()
		expect(runtime.isCompactionInFlight(ferment.id)).toBe(false)
		expect(ctx.ui?.notify).toHaveBeenCalledWith(expect.stringContaining("disk full"), "warning")
	})

	it("clears in-flight without notifying when inlineCompact rejects with an expected error", async () => {
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		const pi = makePi()
		const ctx = makeMidTurnCtx()
		ctx.inlineCompact = vi.fn(async () => {
			throw new Error("no summarizable messages")
		})

		await maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)

		expect(runtime.isCompactionInFlight(ferment.id)).toBe(false)
		expect(ctx.ui?.notify).not.toHaveBeenCalled()
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
		const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		})
		const toolResult = (toolCallId: string): ToolResultMessage => ({
			role: "toolResult",
			toolCallId,
			toolName: "test-tool",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: Date.now(),
		})
		const user = (content: string): UserMessage => ({ role: "user", content, timestamp: Date.now() })
		const toolCall = (id: string) => ({ type: "toolCall" as const, id, name: "test-tool", arguments: {} })

		it("returns true when a toolCall has no matching toolResult", () => {
			expect(isToolCallInFlight([assistant([toolCall("call-1")])])).toBe(true)
		})

		it("returns false when the matching toolResult is present", () => {
			expect(isToolCallInFlight([assistant([toolCall("call-1")]), toolResult("call-1")])).toBe(false)
		})

		it("returns false for empty arrays and messages with no tool calls", () => {
			expect(isToolCallInFlight([])).toBe(false)
			expect(isToolCallInFlight([user("hi")])).toBe(false)
			expect(isToolCallInFlight([assistant([{ type: "text", text: "done" }])])).toBe(false)
		})

		it("returns true when only some toolCalls have matching toolResults", () => {
			const messages = [assistant([toolCall("call-1"), toolCall("call-2")]), toolResult("call-1")]
			expect(isToolCallInFlight(messages)).toBe(true)
		})
	})

	describe("isToolCallInFlightInSession", () => {
		it("returns true when the session contains an in-flight toolCall", () => {
			setSessionEntries(ctx, [
				makeSessionMessageEntry({
					role: "assistant",
					content: [{ type: "toolCall", id: "call-1" }],
				}),
			])
			expect(isToolCallInFlightInSession(ctx)).toBe(true)
		})

		it("returns false when the session has a completed toolCall pair", () => {
			setSessionEntries(ctx, [
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

			setSessionEntries(ctx, [
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

			setSessionEntries(ctx, [
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

// ─── /settings Auto-compact toggle regression ──────────────────────────────
// These blocks prove the global compaction.enabled setting (read by
// getCompactionEnabled) gates BOTH ferment compaction paths. When the toggle
// is disabled, neither maybeTriggerFermentCompaction nor
// maybeTriggerMidTurnFermentCompaction should call ctx.compact().

describe("maybeTriggerFermentCompaction — /settings Auto-compact toggle", () => {
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
		vi.mocked(getCompactionEnabled).mockReturnValue(true)
	})

	afterEach(() => {
		runtime.clearCompactionInFlight("ferment-1")
		clearPendingCompaction("ferment-1")
		vi.restoreAllMocks()
		// restoreAllMocks does not reliably reset module-mock implementations, so
		// re-pin the enabled default to avoid leaking a `false` into other blocks.
		vi.mocked(getCompactionEnabled).mockReturnValue(true)
	})

	it("does NOT compact when the Auto-compact toggle is disabled", () => {
		vi.mocked(getCompactionEnabled).mockReturnValue(false)
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))

		maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(ctx.compact).not.toHaveBeenCalled()
		// The pending compaction must be left untouched (not drained).
		expect(runtime.getPendingCompaction(ferment.id)).toBeDefined()
	})

	it("passes the session's project-trust decision to getCompactionEnabled", async () => {
		ctx.isProjectTrusted = vi.fn(() => true)

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(vi.mocked(getCompactionEnabled)).toHaveBeenCalledWith(true)
	})

	it("warns when the trust accessor fails unexpectedly, and still evaluates the toggle", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		ctx.isProjectTrusted = vi.fn(() => {
			throw new Error("boom")
		})

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("project trust"), expect.any(Error))
		// Trust stays unknown — the toggle is still consulted with undefined.
		expect(vi.mocked(getCompactionEnabled)).toHaveBeenCalledWith(undefined)
	})

	it("stays silent when the trust accessor throws a stale-ctx error", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		ctx.isProjectTrusted = vi.fn(() => {
			throw new Error(STALE_CTX_MESSAGE)
		})

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		expect(warnSpy).not.toHaveBeenCalled()
		expect(vi.mocked(getCompactionEnabled)).toHaveBeenCalledWith(undefined)
	})
})

// Paired tests proving the Auto-compact toggle turns stage compaction on/off for a
// *one-shot* ferment specifically (isOneShot=true with inline compaction available —
// the only path a one-shot run actually compacts).
describe("maybeTriggerFermentCompaction — one-shot Auto-compact toggle", () => {
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
		// One-shot ferment with inline compaction available — the path that compacts.
		pi.getFlag = vi.fn((name) => (name === "ferment-oneshot" ? true : undefined))
		ctx.model = { contextWindow: 100_000 } as ExtensionContext["model"]
		ctx.inlineCompact = vi.fn(async () => ({ tokensBefore: 1_000 }) as CompactionResult)
		vi.mocked(getCompactionEnabled).mockReturnValue(true)
	})

	afterEach(() => {
		runtime.clearCompactionInFlight("ferment-1")
		clearPendingCompaction("ferment-1")
		vi.restoreAllMocks()
		// restoreAllMocks does not reliably reset module-mock implementations, so
		// re-pin the enabled default to avoid leaking a `false` into other blocks.
		vi.mocked(getCompactionEnabled).mockReturnValue(true)
	})

	function seedPendingOneShot(): Ferment {
		const ferment = makeFermentWithPhase(
			{ id: "phase-1", name: "Phase", goal: "Goal" },
			{ id: "step-1", description: "Do it" },
		)
		storageMap.set(ferment.id, ferment)
		runtime.setActive(ferment)
		setPendingCompaction(ferment.id, makePendingStep(ferment.id, "phase-1", "step-1"))
		return ferment
	}

	it("compacts a one-shot ferment when the Auto-compact toggle is ENABLED", async () => {
		vi.mocked(getCompactionEnabled).mockReturnValue(true)
		const ferment = seedPendingOneShot()

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		// Compaction ran via inline compaction, and the pending entry was drained.
		expect(ctx.inlineCompact).toHaveBeenCalledWith(expect.objectContaining({ force: true }))
		expect(runtime.getPendingCompaction(ferment.id)).toBeUndefined()
	})

	it("does NOT compact a one-shot ferment when the Auto-compact toggle is DISABLED", async () => {
		vi.mocked(getCompactionEnabled).mockReturnValue(false)
		const ferment = seedPendingOneShot()

		await maybeTriggerFermentCompaction(pi, ctx, runtime)

		// The toggle gates the one-shot path before any compaction call fires.
		expect(ctx.inlineCompact).not.toHaveBeenCalled()
		expect(ctx.compact).not.toHaveBeenCalled()
		// The pending entry is left untouched (not drained), so it can still run later
		// if the toggle is turned back on.
		expect(runtime.getPendingCompaction(ferment.id)).toBeDefined()
	})
})

describe("maybeTriggerMidTurnFermentCompaction — /settings Auto-compact toggle", () => {
	beforeEach(() => {
		vi.mocked(getCompactionEnabled).mockReturnValue(true)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.mocked(getCompactionEnabled).mockReturnValue(true)
	})

	it("does NOT compact when the Auto-compact toggle is disabled", () => {
		vi.mocked(getCompactionEnabled).mockReturnValue(false)
		const ferment = makeFermentWithPhase()
		ferment.phases[0].status = "active"
		ferment.phases[0].steps[0].status = "running"
		const runtime = makeMidTurnRuntime(ferment)
		const pi = makePi()
		const ctx = makeMidTurnCtx()

		maybeTriggerMidTurnFermentCompaction(pi, ctx, runtime, CONTEXT_WINDOW - 1)

		expect(ctx.compact).not.toHaveBeenCalled()
	})
})
