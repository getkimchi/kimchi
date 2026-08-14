// Unit tests for the ACP plan tracker (ticket #05): ferment lifecycle →
// `plan` sessionUpdates, todos → PlanEntry translation, and scope filtering.

import type { PlanEntry, SessionNotification } from "@agentclientprotocol/sdk"
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FERMENT_EVENTS, type FermentPhaseStartedPayload } from "../../extensions/ferment/domain-events.js"
import { getActive, setActive } from "../../extensions/ferment/state.js"
import { __resetTodoStore, applyWriteTodos } from "../../extensions/todos/store.js"
import type { TodoDraft } from "../../extensions/todos/types.js"
import type { Ferment } from "../../ferment/types.js"
import { AcpPlanTracker, type ActivePlan } from "./plans.js"

const TEST_SESSION_ID = "acp-session"

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-1",
		name: "Plan Test Ferment",
		status: "running",
		worktree: { path: "/tmp" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Implementation",
				goal: "do the work",
				status: "active",
				steps: [
					{ id: "step-1", index: 1, description: "Write the code", status: "pending" },
					{ id: "step-2", index: 2, description: "Run the tests", status: "pending" },
				],
			},
			{
				id: "phase-2",
				index: 2,
				name: "Polish",
				goal: "do the polish",
				status: "planned",
				steps: [{ id: "step-3", index: 1, description: "Ship it", status: "pending" }],
			},
		],
		decisions: [],
		memories: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	}
}

function phaseStartedPayload(ferment: Ferment, phaseId: string): FermentPhaseStartedPayload {
	const phase = ferment.phases.find((p) => p.id === phaseId)
	if (!phase) throw new Error(`unknown phase ${phaseId}`)
	return { fermentId: ferment.id, phaseId: phase.id, phaseIndex: phase.index, phaseName: phase.name }
}

interface Harness {
	bus: EventBus
	emitted: SessionNotification[]
	planChanges: (ActivePlan | undefined)[]
	tracker: AcpPlanTracker
}

function makeHarness(sessionId = TEST_SESSION_ID): Harness {
	const bus = createEventBus()
	const emitted: SessionNotification[] = []
	const planChanges: (ActivePlan | undefined)[] = []
	const tracker = new AcpPlanTracker({
		sessionId,
		events: bus,
		send: (n) => emitted.push(n),
		onActivePlanChanged: (plan) => planChanges.push(plan),
	})
	return { bus, emitted, planChanges, tracker }
}

function planEntries(emitted: SessionNotification[], index: number): PlanEntry[] {
	const update = emitted[index]?.update
	if (update?.sessionUpdate !== "plan") {
		throw new Error(`expected plan update at index ${index}, got ${JSON.stringify(update)}`)
	}
	return update.entries
}

function writePhaseTodos(phaseId: string, todos: TodoDraft[], sessionId = TEST_SESSION_ID): void {
	applyWriteTodos({ scope: { kind: "ferment", phaseId }, todos }, sessionId)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AcpPlanTracker", () => {
	beforeEach(() => {
		__resetTodoStore()
		setActive(undefined)
	})

	afterEach(() => {
		setActive(undefined)
		__resetTodoStore()
	})

	it("emits an initial plan with all entries pending when PHASE_STARTED fires", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, planChanges, tracker } = makeHarness()
		tracker.start()
		try {
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))

			expect(emitted).toHaveLength(1)
			expect(emitted[0].sessionId).toBe(TEST_SESSION_ID)
			const entries = planEntries(emitted, 0)
			expect(entries).toHaveLength(5) // 2 phase headers + 3 steps
			expect(entries.map((e) => e.content)).toEqual([
				"[Phase 1] Implementation",
				"↳ Write the code",
				"↳ Run the tests",
				"[Phase 2] Polish",
				"↳ Ship it",
			])
			expect(entries.every((e) => e.status === "pending")).toBe(true)
			expect(entries.every((e) => e.priority === "medium")).toBe(true)

			// SessionRecord mirror callback receives the planId (v2-ready).
			expect(planChanges).toHaveLength(1)
			expect(planChanges[0]?.planId).toBe("ferment-1")
		} finally {
			tracker.stop()
		}
	})

	it("ignores PHASE_STARTED for a ferment that is not the active one", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, {
				fermentId: "other-ferment",
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Other",
			})
			expect(emitted).toHaveLength(0)
		} finally {
			tracker.stop()
		}
	})

	it("emits nothing on PHASE_STARTED when no ferment is active", () => {
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, {
				fermentId: "ferment-1",
				phaseId: "phase-1",
				phaseIndex: 1,
				phaseName: "Implementation",
			})
			expect(emitted).toHaveLength(0)
		} finally {
			tracker.stop()
		}
	})

	it("re-emits the plan with updated statuses on ferment-scoped todo changes", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
			expect(emitted).toHaveLength(1)

			// Bridge-style write: step 1 in progress (as STEP_STARTED would).
			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "in_progress" },
				{ content: "↳ Write the code", status: "in_progress" },
				{ content: "↳ Run the tests", status: "pending" },
			])
			expect(emitted).toHaveLength(2)
			const first = planEntries(emitted, 1)
			expect(first[0].status).toBe("in_progress")
			expect(first[1].status).toBe("in_progress")
			expect(first[2].status).toBe("pending")

			// Step 1 completes (as STEP_COMPLETED would).
			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "in_progress" },
				{ content: "↳ Write the code", status: "completed" },
				{ content: "↳ Run the tests", status: "pending" },
			])
			expect(emitted).toHaveLength(3)
			const second = planEntries(emitted, 2)
			expect(second[1].status).toBe("completed")
		} finally {
			tracker.stop()
		}
	})

	it("maps blocked todos to ACP in_progress", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))

			// STEP_FAILED → the bridge marks the step todo blocked.
			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "in_progress" },
				{ content: "↳ Write the code", status: "blocked" },
				{ content: "↳ Run the tests", status: "pending" },
			])
			const entries = planEntries(emitted, 1)
			expect(entries[1].status).toBe("in_progress")
		} finally {
			tracker.stop()
		}
	})

	it("excludes global-scope todos from plan entries", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))

			// Model-written global todos (execute-style) must not leak in.
			applyWriteTodos(
				{ scope: { kind: "global" }, todos: [{ content: "unrelated user todo", status: "pending" }] },
				TEST_SESSION_ID,
			)
			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "in_progress" },
				{ content: "↳ Write the code", status: "in_progress" },
				{ content: "↳ Run the tests", status: "pending" },
			])
			const entries = planEntries(emitted, emitted.length - 1)
			expect(entries.some((e) => e.content === "unrelated user todo")).toBe(false)
		} finally {
			tracker.stop()
		}
	})

	it("flattens ferment-step scopes ordered after their phase scope", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))

			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "in_progress" },
				{ content: "↳ Write the code", status: "in_progress" },
				{ content: "↳ Run the tests", status: "pending" },
			])
			// STEP_STARTED seeds the step scope with an anchor todo.
			applyWriteTodos(
				{
					scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
					todos: [{ content: "[Step 1] Write the code", status: "in_progress" }],
				},
				TEST_SESSION_ID,
			)

			// The rebuild flattens only ferment-scoped todos currently in the
			// store: phase 2 never populated its scope, so it drops out until its
			// own PHASE_STARTED re-emits the initial plan.
			const entries = planEntries(emitted, emitted.length - 1)
			expect(entries.map((e) => e.content)).toEqual([
				"[Phase 1] Implementation",
				"↳ Write the code",
				"↳ Run the tests",
				"[Step 1] Write the code",
			])
		} finally {
			tracker.stop()
		}
	})

	it("emits nothing on the execute path (no ferment, scoped todos change)", () => {
		const { emitted, tracker } = makeHarness()
		tracker.start()
		try {
			// No PHASE_STARTED: executePlan() creates no ferment. Even scoped
			// todo writes must not produce a plan (acceptance criterion).
			writePhaseTodos("phase-1", [{ content: "x", status: "pending" }])
			expect(emitted).toHaveLength(0)
		} finally {
			tracker.stop()
		}
	})

	it("ignores todo changes from other sessions", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
			expect(emitted).toHaveLength(1)

			writePhaseTodos("phase-1", [{ content: "other", status: "in_progress" }], "other-session")
			expect(emitted).toHaveLength(1)
		} finally {
			tracker.stop()
		}
	})

	it("dedupes identical consecutive plans", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
			expect(emitted).toHaveLength(1)

			const todos: TodoDraft[] = [
				{ content: "[Phase 1] Implementation", status: "in_progress" },
				{ content: "↳ Write the code", status: "in_progress" },
				{ content: "↳ Run the tests", status: "pending" },
			]
			writePhaseTodos("phase-1", todos)
			expect(emitted).toHaveLength(2)
			// Same content again → no new notification.
			writePhaseTodos("phase-1", todos)
			expect(emitted).toHaveLength(2)
		} finally {
			tracker.stop()
		}
	})

	it("stop() unsubscribes and clears the active plan mirror", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, planChanges, tracker } = makeHarness()
		tracker.start()
		bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
		expect(emitted).toHaveLength(1)

		tracker.stop()
		expect(planChanges[planChanges.length - 1]).toBeUndefined()

		bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-2"))
		writePhaseTodos("phase-2", [{ content: "x", status: "pending" }])
		expect(emitted).toHaveLength(1)
	})

	it("has no active ferment exposure when constructed without events bus", () => {
		// events: undefined (e.g. ferment extension disabled) must not throw.
		const emitted: SessionNotification[] = []
		const tracker = new AcpPlanTracker({
			sessionId: TEST_SESSION_ID,
			events: undefined,
			send: (n) => emitted.push(n),
		})
		tracker.start()
		writePhaseTodos("phase-1", [{ content: "x", status: "pending" }])
		expect(emitted).toHaveLength(0)
		tracker.stop()
	})

	it("reads the active ferment via the injected getter when provided", () => {
		const ferment = makeFerment()
		const bus = createEventBus()
		const emitted: SessionNotification[] = []
		let getterCalled = 0
		const tracker = new AcpPlanTracker({
			sessionId: TEST_SESSION_ID,
			events: bus,
			send: (n) => emitted.push(n),
			getActiveFerment: () => {
				getterCalled++
				return getActive()
			},
		})
		setActive(ferment)
		tracker.start()
		try {
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
			expect(emitted).toHaveLength(1)
			expect(getterCalled).toBeGreaterThan(0)
		} finally {
			tracker.stop()
		}
	})
})
