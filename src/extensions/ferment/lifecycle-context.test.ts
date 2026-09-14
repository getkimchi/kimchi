import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { createEventBus } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import { createContext } from "../__mocks__/context.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import { markHarnessSteer } from "../steer-marker.js"
import { FERMENT_EVENTS } from "./domain-events.js"
import { FERMENT_LIFECYCLE_CUSTOM_TYPE, registerFermentLifecycleContext } from "./lifecycle-context.js"
import { createDefaultFermentRuntime, type FermentRuntime } from "./runtime.js"
import type { ContinuationPolicy } from "./state.js"

const getMultiModelEnabledMock = vi.fn(() => true)
vi.mock("../multi-model.js", (importOriginal) => {
	return importOriginal<typeof import("../multi-model.js")>().then((mod) => ({
		...mod,
		getMultiModelEnabled: () => getMultiModelEnabledMock(),
	}))
})

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

const TEST_SESSION_ID = "test-session"

interface MessageLike {
	role?: string
	customType?: string
	content?: unknown
}

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-1",
		name: "Test Ferment",
		status: "running",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Build the feature",
				goal: "Ship it",
				status: "active",
				steps: [
					{ id: "step-1", index: 1, description: "Do thing one", status: "done" },
					{ id: "step-2", index: 2, description: "Do thing two", status: "pending" },
				],
			},
		],
		decisions: [],
		memories: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}
}

function makeRuntime(fermentOverrides: Partial<Ferment> = {}, policy: ContinuationPolicy = "manual"): FermentRuntime {
	const ferment = makeFerment(fermentOverrides)
	return {
		...createDefaultFermentRuntime(),
		getActive: () => ferment,
		getContinuationPolicy: () => policy,
	}
}

function makeNoActiveRuntime(): FermentRuntime {
	return {
		...createDefaultFermentRuntime(),
		getActive: () => undefined,
	}
}

/** A runtime whose active ferment can be swapped mid-test to simulate
 *  lifecycle transitions (the persistence layer re-renders on domain events
 *  and dedupes against the previously persisted block). */
function makeMutableRuntime(initial: Ferment | undefined): {
	runtime: FermentRuntime
	setActive: (f?: Ferment) => void
} {
	let active = initial
	return {
		runtime: {
			...createDefaultFermentRuntime(),
			getActive: () => active,
		},
		setActive: (f) => {
			active = f
		},
	}
}

function createHarness(branch: Record<string, unknown>[] | (() => Record<string, unknown>[]) = []) {
	const handlers = new Map<string, ExtensionHandler[]>()
	const bus = createEventBus()
	const pi = {
		events: bus,
		sendMessage: vi.fn(),
		on: vi.fn((event: string, handler: ExtensionHandler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
	} as unknown as ExtensionAPI

	const ctx = createContext({
		sessionManager: {
			getSessionId: () => TEST_SESSION_ID,
			getBranch: () => (typeof branch === "function" ? branch() : branch) as unknown as SessionEntry[],
		},
	})

	async function fire(event: string, payload: unknown): Promise<unknown> {
		let result: unknown
		for (const handler of handlers.get(event) ?? []) {
			result = await handler(payload, ctx)
		}
		return result
	}

	type SentMessage = { customType?: string; display?: boolean; content?: unknown }

	function persistedBlocks(): SentMessage[] {
		return vi
			.mocked(pi.sendMessage)
			.mock.calls.map(([message]) => message as unknown as SentMessage)
			.filter((message) => message.customType === FERMENT_LIFECYCLE_CUSTOM_TYPE)
	}

	return { pi, bus, ctx, fire, persistedBlocks }
}

async function startSession(harness: ReturnType<typeof createHarness>): Promise<void> {
	await harness.fire("session_start", { reason: "new" })
}

describe("registerFermentLifecycleContext", () => {
	beforeEach(() => {
		getMultiModelEnabledMock.mockReturnValue(true)
	})

	it("defers transitions while the agent is busy and flushes once on agent_settled, not agent_end", async () => {
		const harness = createHarness()
		const { runtime, setActive } = makeMutableRuntime(makeFerment())
		registerFermentLifecycleContext(harness.pi, runtime)
		await startSession(harness)

		await harness.fire("agent_start", {})
		harness.bus.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "ferment-1", phaseId: "phase-1", stepId: "step-1" })
		expect(harness.persistedBlocks()).toHaveLength(0)

		// agent_end must NOT flush: while the run is still settling upstream,
		// a steered send would be queued as a pending agent steer.
		await harness.fire("agent_end", {})
		expect(harness.persistedBlocks()).toHaveLength(0)

		// At agent_settled the run is fully inactive: plain append, no steer.
		await harness.fire("agent_settled", {})
		expect(harness.persistedBlocks()).toHaveLength(1)
		expect(harness.persistedBlocks()[0]?.content).toContain("## Current lifecycle state")

		// Further transitions during the next busy run coalesce.
		const phase = makeFerment().phases[0]
		if (!phase) throw new Error("expected phase fixture")
		setActive(
			makeFerment({
				phases: [
					{
						...phase,
						steps: [
							{ id: "step-1", index: 1, description: "Do thing one", status: "done" },
							{ id: "step-2", index: 2, description: "Do thing two", status: "done" },
						],
					},
				],
			}),
		)
		await harness.fire("agent_start", {})
		harness.bus.emit(FERMENT_EVENTS.STEP_COMPLETED, { fermentId: "ferment-1", phaseId: "phase-1", stepId: "step-2" })
		await harness.fire("agent_end", {})
		expect(harness.persistedBlocks()).toHaveLength(1)
		await harness.fire("agent_settled", {})
		expect(harness.persistedBlocks()).toHaveLength(2)
	})

	it("does not flush after an aborted run; the block lands at the next normal settle", async () => {
		const abortedAssistant = {
			type: "message",
			id: "aborted-1",
			parentId: null,
			timestamp: "",
			message: { role: "assistant", stopReason: "aborted", content: [] },
		}
		const branch: Record<string, unknown>[] = []
		const harness = createHarness(branch)
		const { runtime } = makeMutableRuntime(makeFerment())
		registerFermentLifecycleContext(harness.pi, runtime)
		await startSession(harness)

		await harness.fire("agent_start", {})
		harness.bus.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "ferment-1", phaseId: "phase-1", stepId: "step-1" })
		await harness.fire("agent_end", {})
		branch.push(abortedAssistant)
		await harness.fire("agent_settled", {})
		expect(harness.persistedBlocks()).toHaveLength(0)

		await harness.fire("agent_start", {})
		await harness.fire("agent_end", {})
		branch.push({
			type: "message",
			id: "normal-1",
			parentId: null,
			timestamp: "",
			message: { role: "assistant", stopReason: "stop", content: [] },
		})
		await harness.fire("agent_settled", {})
		expect(harness.persistedBlocks()).toHaveLength(1)
	})

	it("re-emits the newest lifecycle block at the next settle when compaction cut it from the branch", async () => {
		let branch: Record<string, unknown>[] = []
		const harness = createHarness(() => branch)
		registerFermentLifecycleContext(harness.pi, makeRuntime())
		await startSession(harness)

		await harness.fire("agent_start", {})
		harness.bus.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "ferment-1", phaseId: "phase-1", stepId: "step-1" })
		await harness.fire("agent_end", {})
		await harness.fire("agent_settled", {})
		expect(harness.persistedBlocks()).toHaveLength(1)

		// Compaction summarizes the block: the journal entry leaves the branch.
		branch = []
		await harness.fire("session_compact", { reason: "threshold" })
		await harness.fire("agent_start", {})
		await harness.fire("agent_end", {})
		await harness.fire("agent_settled", {})
		expect(harness.persistedBlocks()).toHaveLength(2)
		expect(harness.persistedBlocks()[1]?.content).toBe(harness.persistedBlocks()[0]?.content)
	})

	it("persists a hidden lifecycle block once per transition for a running ferment", async () => {
		const harness = createHarness()
		const { runtime, setActive } = makeMutableRuntime(makeFerment())
		registerFermentLifecycleContext(harness.pi, runtime)
		await startSession(harness)

		harness.bus.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "ferment-1", phaseId: "phase-1", stepId: "step-1" })

		expect(harness.persistedBlocks()).toHaveLength(1)
		const block = harness.persistedBlocks()[0]
		expect(block?.display).toBe(false)
		const content = block?.content as string
		expect(content).toMatch(/^<system-reminder>\n/)
		expect(content).toContain("## Current lifecycle state")
		expect(content).toContain('Scoping is COMPLETE (ferment status "running"')
		expect(content).toContain('active phase "phase-1" ("Build the feature"), 1/2 steps terminal in phase "phase-1"')
		expect(content).toContain("Next action:")

		// A repeated event without an actual transition persists nothing new.
		harness.bus.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "ferment-1", phaseId: "phase-1", stepId: "step-1" })
		expect(harness.persistedBlocks()).toHaveLength(1)

		// A real transition (step completes → 2/2 terminal) persists exactly
		// one more block.
		const phase = makeFerment().phases[0]
		if (!phase) throw new Error("expected phase fixture")
		setActive(
			makeFerment({
				phases: [
					{
						...phase,
						steps: [
							{ id: "step-1", index: 1, description: "Do thing one", status: "done" },
							{ id: "step-2", index: 2, description: "Do thing two", status: "done" },
						],
					},
				],
			}),
		)
		harness.bus.emit(FERMENT_EVENTS.STEP_COMPLETED, { fermentId: "ferment-1", phaseId: "phase-1", stepId: "step-2" })
		expect(harness.persistedBlocks()).toHaveLength(2)
		expect(harness.persistedBlocks()[1]?.content).toContain('2/2 steps terminal in phase "phase-1"')
	})

	it("persists the next-action hint for a planned ferment", async () => {
		const harness = createHarness()
		const phase = makeFerment().phases[0]
		if (!phase) throw new Error("expected phase fixture")
		registerFermentLifecycleContext(
			harness.pi,
			makeRuntime({
				status: "planned",
				phases: [{ ...phase, status: "planned" }],
			}),
		)
		await startSession(harness)

		harness.bus.emit(FERMENT_EVENTS.SCOPING_COMPLETE, { fermentId: "ferment-1" })

		expect(harness.persistedBlocks()).toHaveLength(1)
		const content = harness.persistedBlocks()[0]?.content as string
		expect(content).toContain('ferment status "planned"')
		expect(content).toContain("Next action: call `activate_ferment_phase`")
		expect(content).toContain('phase_id "phase-1"')
	})

	it("counts failed steps as terminal in active-phase progress", async () => {
		const harness = createHarness()
		const phase = makeFerment().phases[0]
		if (!phase) throw new Error("expected phase fixture")
		registerFermentLifecycleContext(
			harness.pi,
			makeRuntime({
				phases: [
					{
						...phase,
						steps: [{ id: "step-1", index: 1, description: "Broken step", status: "failed" }],
					},
				],
			}),
		)
		await startSession(harness)

		harness.bus.emit(FERMENT_EVENTS.STEP_FAILED, { fermentId: "ferment-1", phaseId: "phase-1", stepId: "step-1" })
		expect(harness.persistedBlocks()[0]?.content).toContain('1/1 steps terminal in phase "phase-1"')
	})

	it("reports progress for every active phase in a parallel group", async () => {
		const harness = createHarness()
		const phase = makeFerment().phases[0]
		if (!phase) throw new Error("expected phase fixture")
		registerFermentLifecycleContext(
			harness.pi,
			makeRuntime({
				phases: [
					{ ...phase, parallel: true, groupIndex: 1 },
					{
						...phase,
						id: "phase-2",
						index: 2,
						name: "Test the feature",
						parallel: true,
						groupIndex: 1,
						steps: [{ id: "step-3", index: 1, description: "Test it", status: "pending" }],
					},
				],
			}),
		)
		await startSession(harness)

		harness.bus.emit(FERMENT_EVENTS.PHASE_STARTED, { fermentId: "ferment-1", phaseId: "phase-1" })
		const content = harness.persistedBlocks()[0]?.content as string
		expect(content).toContain('1/2 steps terminal in phase "phase-1"')
		expect(content).toContain('0/1 steps terminal in phase "phase-2"')
	})

	for (const status of ["draft", "paused", "complete", "abandoned"] as FermentStatus[]) {
		it(`persists nothing for a ${status} ferment`, async () => {
			const harness = createHarness()
			registerFermentLifecycleContext(harness.pi, makeRuntime({ status }))
			await startSession(harness)

			harness.bus.emit(FERMENT_EVENTS.RESUMED, { fermentId: "ferment-1" })
			harness.bus.emit(FERMENT_EVENTS.PHASE_STARTED, { fermentId: "ferment-1" })
			expect(harness.persistedBlocks()).toHaveLength(0)
		})
	}

	it("a complete transition persists nothing (the last running block stays in history)", async () => {
		const harness = createHarness()
		const { runtime, setActive } = makeMutableRuntime(makeFerment())
		registerFermentLifecycleContext(harness.pi, runtime)
		await startSession(harness)

		harness.bus.emit(FERMENT_EVENTS.PHASE_STARTED, { fermentId: "ferment-1", phaseId: "phase-1" })
		expect(harness.persistedBlocks()).toHaveLength(1)

		setActive(makeFerment({ status: "complete" }))
		harness.bus.emit(FERMENT_EVENTS.COMPLETED, { fermentId: "ferment-1" })
		expect(harness.persistedBlocks()).toHaveLength(1)
	})

	it("persists nothing when no ferment is active", async () => {
		const harness = createHarness()
		registerFermentLifecycleContext(harness.pi, makeNoActiveRuntime())
		await startSession(harness)

		harness.bus.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "ferment-1" })
		expect(harness.persistedBlocks()).toHaveLength(0)
	})

	it("persists nothing for agent workers", async () => {
		const harness = createHarness()
		registerFermentLifecycleContext(harness.pi, makeRuntime())
		await startSession(harness)

		await runAsAgentWorker(async () => {
			harness.bus.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "ferment-1" })
			expect(harness.persistedBlocks()).toHaveLength(0)
		})
	})

	it("does not re-persist on resume when history already holds the current block", async () => {
		const harness = createHarness()
		const { runtime } = makeMutableRuntime(makeFerment())
		registerFermentLifecycleContext(harness.pi, runtime)
		await startSession(harness)

		// Produce the definitive current block first.
		harness.bus.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "ferment-1" })
		expect(harness.persistedBlocks()).toHaveLength(1)
		const persistedContent = harness.persistedBlocks()[0]?.content

		// Simulate a fresh registration against a resumed session whose branch
		// already contains that exact block: no duplicate persist. History
		// entries use the real journal shape (custom_message, no `role`).
		const resumed = createHarness([
			{
				type: "message",
				id: "msg-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "resume me" },
			},
			{
				type: "custom_message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				customType: FERMENT_LIFECYCLE_CUSTOM_TYPE,
				content: persistedContent,
				display: false,
			},
		])
		registerFermentLifecycleContext(resumed.pi, runtime)
		await resumed.fire("session_start", { reason: "resume" })

		resumed.bus.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "ferment-1" })
		expect(resumed.persistedBlocks()).toHaveLength(0)
	})

	it("strip-only context handler keeps the newest lifecycle block", async () => {
		const newest = markHarnessSteer("## Current lifecycle state\n- newest")
		const messages: MessageLike[] = [
			{ role: "user", content: "u1" },
			{ role: "custom", customType: FERMENT_LIFECYCLE_CUSTOM_TYPE, content: markHarnessSteer("older") },
			{ role: "assistant", content: "asst" },
			{ role: "custom", customType: FERMENT_LIFECYCLE_CUSTOM_TYPE, content: newest },
			{ role: "user", content: "u2" },
		]

		const harness = createHarness()
		registerFermentLifecycleContext(harness.pi, makeRuntime())
		await startSession(harness)

		const result = (await harness.fire("context", { messages })) as { messages: MessageLike[] }
		const retained = result.messages.filter((m) => m.customType === FERMENT_LIFECYCLE_CUSTOM_TYPE)
		expect(retained).toHaveLength(1)
		expect(retained[0]?.content).toBe(newest)
		expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "custom", "user"])
	})

	it("context handler never appends a lifecycle block (no tail push)", async () => {
		const harness = createHarness()
		registerFermentLifecycleContext(harness.pi, makeRuntime())
		await startSession(harness)

		const result = (await harness.fire("context", { messages: [] })) as unknown
		expect(result).toBeUndefined()
	})

	it("uses the multi-model flag to shape delegation hints", async () => {
		const harness = createHarness()
		getMultiModelEnabledMock.mockReturnValue(false)
		registerFermentLifecycleContext(harness.pi, makeRuntime())
		await startSession(harness)

		harness.bus.emit(FERMENT_EVENTS.STEP_STARTED, { fermentId: "ferment-1" })
		const content = harness.persistedBlocks()[0]?.content as string
		// In single-model mode, the next-action suffix tells the planner it should
		// execute the step directly instead of always spawning a subagent.
		expect(content).toContain("Then execute the step directly")
	})
})
