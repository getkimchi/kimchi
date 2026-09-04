// Unit tests for the ACP plan tracker (ticket #05): ferment lifecycle →
// `plan` sessionUpdates, todos → PlanEntry translation, and scope filtering.

import type { PlanEntry, SessionNotification } from "@agentclientprotocol/sdk"
import { createEventBus, type EventBus, type SessionEntry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FERMENT_EVENTS, type FermentPhaseStartedPayload } from "../../extensions/ferment/domain-events.js"
import { clearAllPendingScopes, setPendingScope } from "../../extensions/ferment/scoping.js"
import { getActive, setActive } from "../../extensions/ferment/state.js"
import { PERMISSION_MODE_SESSION_ENTRY_TYPE } from "../../extensions/permissions/mode.js"
import { __resetTodoStore, applyWriteTodos } from "../../extensions/todos/store.js"
import type { TodoDraft } from "../../extensions/todos/types.js"
import type { Ferment } from "../../ferment/types.js"
import {
	PLAN_REVIEW_REQUEST_CHANNEL,
	PLAN_REVIEW_RESOLVED_CHANNEL,
	PLAN_REVIEW_RESOLVED_CUSTOM_TYPE,
} from "../../shared/planning/plan-review-bus.js"
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
	setPermissionMode: (mode: string) => void
	tracker: AcpPlanTracker
}

function makeHarness(sessionId = TEST_SESSION_ID, entries: SessionEntry[] = []): Harness {
	const bus = createEventBus()
	const emitted: SessionNotification[] = []
	const planChanges: (ActivePlan | undefined)[] = []
	let permissionMode = "default"
	const tracker = new AcpPlanTracker({
		sessionId,
		events: bus,
		send: (n) => emitted.push(n),
		getPermissionMode: () => permissionMode,
		getSessionEntries: () => entries,
		onActivePlanChanged: (plan) => planChanges.push(plan),
	})
	return { bus, emitted, planChanges, setPermissionMode: (mode) => (permissionMode = mode), tracker }
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

/** Simulate the todo-sync bridge's PHASE_STARTED write. The bridge subscribes
 *  at session_start — before any ACP tracker — so the owning session already
 *  has the phase's scope todos in its bucket when the tracker's bus handler
 *  runs. The tracker uses this to correlate the process-global ferment event
 *  with the session that owns it. Content is irrelevant; length > 0 matters. */
function simulateBridgePhaseWrite(phaseId: string, sessionId = TEST_SESSION_ID): void {
	writePhaseTodos(phaseId, [{ content: `[bridge] ${phaseId}`, status: "in_progress" }], sessionId)
}

function customEntry(customType: string, data?: unknown): SessionEntry {
	return { type: "custom", customType, data } as SessionEntry
}

function globalTodoEntry(content: string): SessionEntry {
	return customEntry("kimchi.todos", {
		schemaVersion: 1,
		scope: { kind: "global" },
		todos: [{ id: "todo-1", content, status: "pending" }],
	})
}

function permissionModeEntry(mode: string): SessionEntry {
	return customEntry(PERMISSION_MODE_SESSION_ENTRY_TYPE, { mode, initiatedBy: "user", source: "runtime" })
}

function emitAdhocPlanReview(bus: EventBus): void {
	bus.emit(PLAN_REVIEW_REQUEST_CHANNEL, {
		sessionId: TEST_SESSION_ID,
		planContent: "## Goal\nShip it\n\n## Chunks\n\n### Chunk 1: Build\nDo it",
		source: "adhoc",
	})
}

function emitResolved(bus: EventBus): void {
	bus.emit(PLAN_REVIEW_RESOLVED_CHANNEL, {
		sessionId: TEST_SESSION_ID,
		decision: "execute",
		planReviewSource: "adhoc",
		outcome: "accepted",
	})
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AcpPlanTracker", () => {
	beforeEach(() => {
		__resetTodoStore()
		setActive(undefined)
	})

	afterEach(() => {
		setActive(undefined)
		clearAllPendingScopes()
		__resetTodoStore()
	})

	it("emits an initial plan with all entries pending when PHASE_STARTED fires", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, planChanges, tracker } = makeHarness()
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1")
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

	it("skips the initial plan when the ferment belongs to another session", () => {
		// The bridge wrote phase todos into a DIFFERENT session's bucket, so
		// this session did not receive the ferment-binding write: the process-
		// global PHASE_STARTED must not produce a plan here.
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1", "other-session")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
			expect(emitted).toHaveLength(0)
		} finally {
			tracker.stop()
		}
	})

	it("does not let another session's active ferment suppress global todos", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1", "other-session")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
			applyWriteTodos(
				{ scope: { kind: "global" }, todos: [{ content: "session-local todo", status: "pending" }] },
				TEST_SESSION_ID,
			)
			expect(emitted).toHaveLength(1)
			expect(planEntries(emitted, 0)[0].content).toBe("session-local todo")
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
			simulateBridgePhaseWrite("phase-1")
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

	it("maps blocked todos to pending with a [blocked] marker", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))

			// STEP_FAILED → the bridge marks the step todo blocked.
			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "in_progress" },
				{ content: "↳ Write the code", status: "blocked" },
				{ content: "↳ Run the tests", status: "pending" },
			])
			const entries = planEntries(emitted, 1)
			expect(entries[1].status).toBe("pending")
			expect(entries[1].content).toBe("[blocked] ↳ Write the code")
		} finally {
			tracker.stop()
		}
	})

	it("appends the todo note to the [blocked] marker", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))

			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "in_progress" },
				{ content: "↳ deploy", status: "blocked", note: "waiting on ops" },
				{ content: "↳ Run the tests", status: "pending" },
			])
			const entries = planEntries(emitted, 1)
			expect(entries[1].status).toBe("pending")
			expect(entries[1].content).toBe("[blocked] ↳ deploy — waiting on ops")
		} finally {
			tracker.stop()
		}
	})

	it("uses activeForm for in_progress entries, falling back to content", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))

			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "in_progress", activeForm: "Implementing" },
				{ content: "↳ write tests", status: "in_progress" },
				{ content: "↳ Run the tests", status: "pending" },
			])
			const entries = planEntries(emitted, 1)
			expect(entries[0].content).toBe("Implementing")
			expect(entries[1].content).toBe("↳ write tests")
			// activeForm must not leak into non-in_progress statuses.
			expect(entries[2].content).toBe("↳ Run the tests")
		} finally {
			tracker.stop()
		}
	})

	it("emits a resume snapshot from restored ferment-scoped todos", () => {
		const ferment = makeFerment()
		setActive(ferment)
		// Session restarted mid-ferment: the store is restored from the
		// persisted branch BEFORE the session's tracker starts, and no
		// PHASE_STARTED fires for the already-active phase.
		writePhaseTodos("phase-1", [
			{ content: "[Phase 1] Implementation", status: "in_progress" },
			{ content: "↳ Write the code", status: "completed" },
			{ content: "↳ Run the tests", status: "pending" },
		])
		const { emitted, planChanges, tracker } = makeHarness()
		tracker.start()
		try {
			tracker.emitRestoredSnapshot()
			expect(emitted).toHaveLength(1)
			const entries = planEntries(emitted, 0)
			expect(entries.map((e) => e.status)).toEqual(["in_progress", "completed", "pending"])
			expect(planChanges[0]?.planId).toBe("ferment-1")
		} finally {
			tracker.stop()
		}
	})

	it("resume snapshot emits nothing when no todos exist at all", () => {
		const { emitted, tracker } = makeHarness()
		tracker.start()
		try {
			tracker.emitRestoredSnapshot()
			expect(emitted).toHaveLength(0)
		} finally {
			tracker.stop()
		}
	})

	it("resume snapshot skips global-scope todos written before the latest review resolution", () => {
		applyWriteTodos(
			{ scope: { kind: "global" }, todos: [{ content: "restored task", status: "in_progress" }] },
			TEST_SESSION_ID,
		)
		const branch = [
			globalTodoEntry("restored task"),
			customEntry(PLAN_REVIEW_RESOLVED_CUSTOM_TYPE, {
				sessionId: TEST_SESSION_ID,
				source: "adhoc",
				decision: "execute",
				outcome: "accepted",
			}),
		]
		const { emitted, tracker } = makeHarness(TEST_SESSION_ID, branch)
		tracker.start()
		try {
			tracker.emitRestoredSnapshot()
			expect(emitted).toHaveLength(0)
		} finally {
			tracker.stop()
		}
	})

	it("resume snapshot restores global-scope todos written after the latest review resolution", () => {
		applyWriteTodos(
			{ scope: { kind: "global" }, todos: [{ content: "execution task", status: "pending" }] },
			TEST_SESSION_ID,
		)
		const branch = [
			customEntry(PLAN_REVIEW_RESOLVED_CUSTOM_TYPE, {
				sessionId: TEST_SESSION_ID,
				source: "adhoc",
				decision: "execute",
				outcome: "accepted",
			}),
			globalTodoEntry("execution task"),
		]
		const { emitted, tracker } = makeHarness(TEST_SESSION_ID, branch)
		tracker.start()
		try {
			tracker.emitRestoredSnapshot()
			expect(emitted).toHaveLength(1)
			expect(planEntries(emitted, 0)[0].content).toBe("execution task")
		} finally {
			tracker.stop()
		}
	})

	it("resume snapshot restores post-approval global todos even when the loaded permission mode is plan", () => {
		applyWriteTodos(
			{ scope: { kind: "global" }, todos: [{ content: "execution task", status: "pending" }] },
			TEST_SESSION_ID,
		)
		const branch = [
			customEntry(PLAN_REVIEW_RESOLVED_CUSTOM_TYPE, {
				sessionId: TEST_SESSION_ID,
				source: "adhoc",
				decision: "execute",
				outcome: "accepted",
			}),
			globalTodoEntry("execution task"),
		]
		const { emitted, setPermissionMode, tracker } = makeHarness(TEST_SESSION_ID, branch)
		tracker.start()
		try {
			setPermissionMode("plan")
			tracker.emitRestoredSnapshot()
			expect(emitted).toHaveLength(1)
			expect(planEntries(emitted, 0)[0].content).toBe("execution task")
		} finally {
			tracker.stop()
		}
	})

	it("resume snapshot hides plan-mode global todos before any review has resolved", () => {
		applyWriteTodos(
			{ scope: { kind: "global" }, todos: [{ content: "planning scratchpad", status: "pending" }] },
			TEST_SESSION_ID,
		)
		const { emitted, setPermissionMode, tracker } = makeHarness(TEST_SESSION_ID, [
			globalTodoEntry("planning scratchpad"),
		])
		tracker.start()
		try {
			setPermissionMode("plan")
			tracker.emitRestoredSnapshot()
			expect(emitted).toHaveLength(0)
		} finally {
			tracker.stop()
		}
	})

	it("resume snapshot hides plan-mode scratchpad todos written after rework", () => {
		applyWriteTodos(
			{ scope: { kind: "global" }, todos: [{ content: "revision scratchpad", status: "pending" }] },
			TEST_SESSION_ID,
		)
		const branch = [
			customEntry(PLAN_REVIEW_RESOLVED_CUSTOM_TYPE, {
				sessionId: TEST_SESSION_ID,
				source: "adhoc",
				decision: "rework",
				outcome: "rework",
			}),
			globalTodoEntry("revision scratchpad"),
		]
		const { emitted, setPermissionMode, tracker } = makeHarness(TEST_SESSION_ID, branch)
		tracker.start()
		try {
			setPermissionMode("plan")
			tracker.emitRestoredSnapshot()
			expect(emitted).toHaveLength(0)
		} finally {
			tracker.stop()
		}
	})

	it("resume snapshot hides a new plan's scratchpad after an older plan was accepted", () => {
		applyWriteTodos(
			{ scope: { kind: "global" }, todos: [{ content: "second plan scratchpad", status: "pending" }] },
			TEST_SESSION_ID,
		)
		const branch = [
			customEntry(PLAN_REVIEW_RESOLVED_CUSTOM_TYPE, {
				sessionId: TEST_SESSION_ID,
				source: "adhoc",
				decision: "execute",
				outcome: "accepted",
			}),
			globalTodoEntry("first plan execution"),
			permissionModeEntry("plan"),
			globalTodoEntry("second plan scratchpad"),
		]
		const { emitted, setPermissionMode, tracker } = makeHarness(TEST_SESSION_ID, branch)
		tracker.start()
		try {
			setPermissionMode("plan")
			tracker.emitRestoredSnapshot()
			expect(emitted).toHaveLength(0)
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
			simulateBridgePhaseWrite("phase-1")
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
			simulateBridgePhaseWrite("phase-1")
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
			// own PHASE_STARTED re-emits the initial plan. The seeded `[Step 1]`
			// anchor merges into its `↳` summary row instead of duplicating it.
			const entries = planEntries(emitted, emitted.length - 1)
			expect(entries.map((e) => e.content)).toEqual(["[Phase 1] Implementation", "↳ Write the code", "↳ Run the tests"])
		} finally {
			tracker.stop()
		}
	})

	it("merges the seeded step anchor into the phase summary row instead of duplicating it", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))

			// Summary row lags at the seeded status — the bridge only flips it at
			// STEP_COMPLETED, so while the step runs it still says "pending".
			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "in_progress" },
				{ content: "↳ Write the code", status: "pending", _syncKey: "step-1" },
				{ content: "↳ Run the tests", status: "pending" },
			])
			// STEP_STARTED seeds the step scope with the in_progress anchor,
			// tagged with the reserved `_syncKey`. Content is deliberately NOT
			// the `[Step N] <desc>` seed format so the key (not content equality)
			// must drive the merge — mirrors how the bridge tag survives the
			// store's whitespace normalization.
			applyWriteTodos(
				{
					scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
					todos: [{ content: "Implementing the sessions formatter", status: "in_progress", _syncKey: "anchor" }],
				},
				TEST_SESSION_ID,
			)

			const entries = planEntries(emitted, emitted.length - 1)
			// Anchor status propagates onto the summary row; the anchor row
			// itself is suppressed so the step appears exactly once.
			expect(entries.map((e) => e.content)).toEqual(["[Phase 1] Implementation", "↳ Write the code", "↳ Run the tests"])
			expect(entries[1].status).toBe("in_progress")
		} finally {
			tracker.stop()
		}
	})

	it("keeps model-written step sub-tasks while suppressing only the seeded anchor", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))

			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "in_progress" },
				{ content: "↳ Write the code", status: "pending" },
				{ content: "↳ Run the tests", status: "pending" },
			])
			// Model extends the step scope: anchor plus its own sub-task.
			applyWriteTodos(
				{
					scope: { kind: "ferment-step", phaseId: "phase-1", stepId: "step-1" },
					todos: [
						{ content: "[Step 1] Write the code", status: "in_progress" },
						{ content: "refactor registry wiring", status: "pending" },
					],
				},
				TEST_SESSION_ID,
			)

			const entries = planEntries(emitted, emitted.length - 1)
			expect(entries.map((e) => e.content)).toEqual([
				"[Phase 1] Implementation",
				"↳ Write the code",
				"↳ Run the tests",
				"refactor registry wiring",
			])
		} finally {
			tracker.stop()
		}
	})

	it("emits a pending ad-hoc proposal and clears it when the review resolves", () => {
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			emitAdhocPlanReview(bus)
			expect(emitted).toHaveLength(1)
			expect(planEntries(emitted, 0)).toEqual([{ content: "Chunk 1: Build", priority: "medium", status: "pending" }])

			emitResolved(bus)
			expect(emitted).toHaveLength(2)
			expect(planEntries(emitted, 1)).toEqual([])
		} finally {
			tracker.stop()
		}
	})

	it("emits a pending ferment proposal from the pending scope buffer", () => {
		setPendingScope("ferment-pending", {
			goal: "Goal",
			successCriteria: ["Works"],
			constraints: [],
			phases: [{ name: "Scoping", goal: "Build", steps: [{ description: "Wire ACP review" }] }],
		})
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			bus.emit(PLAN_REVIEW_REQUEST_CHANNEL, {
				sessionId: TEST_SESSION_ID,
				planContent: "# Plan fallback",
				source: "ferment",
				fermentId: "ferment-pending",
			})
			expect(emitted).toHaveLength(1)
			expect(planEntries(emitted, 0).map((entry) => entry.content)).toEqual(["[Phase 1] Scoping", "↳ Wire ACP review"])
			expect(planEntries(emitted, 0).every((entry) => entry.status === "pending")).toBe(true)
		} finally {
			tracker.stop()
		}
	})

	it("keeps planning scratchpad global todos hidden while permission mode is plan", () => {
		const { emitted, setPermissionMode, tracker } = makeHarness()
		tracker.start()
		try {
			setPermissionMode("plan")
			applyWriteTodos(
				{ scope: { kind: "global" }, todos: [{ content: "research the codebase", status: "in_progress" }] },
				TEST_SESSION_ID,
			)
			expect(emitted).toHaveLength(0)
		} finally {
			tracker.stop()
		}
	})

	it("emits global-scope todos outside plan/review mode", () => {
		const { emitted, tracker } = makeHarness()
		tracker.start()
		try {
			applyWriteTodos(
				{ scope: { kind: "global" }, todos: [{ content: "write tests", status: "pending" }] },
				TEST_SESSION_ID,
			)
			expect(emitted).toHaveLength(1)
			const entries = planEntries(emitted, 0)
			expect(entries).toHaveLength(1)
			expect(entries[0].content).toBe("write tests")
			expect(entries[0].status).toBe("pending")
		} finally {
			tracker.stop()
		}
	})

	it("updates global todo statuses", () => {
		const { emitted, tracker } = makeHarness()
		tracker.start()
		try {
			applyWriteTodos(
				{
					scope: { kind: "global" },
					todos: [
						{ content: "write tests", status: "in_progress" },
						{ content: "run linter", status: "pending" },
					],
				},
				TEST_SESSION_ID,
			)
			expect(emitted).toHaveLength(1)

			applyWriteTodos(
				{
					scope: { kind: "global" },
					todos: [
						{ content: "write tests", status: "completed" },
						{ content: "run linter", status: "in_progress" },
					],
				},
				TEST_SESSION_ID,
			)
			expect(emitted).toHaveLength(2)
			const entries = planEntries(emitted, 1)
			expect(entries[0].status).toBe("completed")
			expect(entries[1].status).toBe("in_progress")
		} finally {
			tracker.stop()
		}
	})

	it("emits empty entries when all global todos are cleared", () => {
		const { emitted, tracker } = makeHarness()
		tracker.start()
		try {
			applyWriteTodos({ scope: { kind: "global" }, todos: [{ content: "task", status: "pending" }] }, TEST_SESSION_ID)
			expect(emitted).toHaveLength(1)

			applyWriteTodos({ scope: { kind: "global" }, todos: [] }, TEST_SESSION_ID)
			expect(emitted).toHaveLength(2)
			expect(planEntries(emitted, 1)).toHaveLength(0)
		} finally {
			tracker.stop()
		}
	})

	it("uses activeForm for global in_progress entries", () => {
		const { emitted, tracker } = makeHarness()
		tracker.start()
		try {
			applyWriteTodos(
				{
					scope: { kind: "global" },
					todos: [{ content: "write tests", status: "in_progress", activeForm: "writing tests" }],
				},
				TEST_SESSION_ID,
			)
			const entries = planEntries(emitted, 0)
			expect(entries[0].content).toBe("writing tests")
		} finally {
			tracker.stop()
		}
	})

	it("ferment PHASE_STARTED takes over from plan-mode emission", () => {
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		try {
			// Global todo writes first.
			applyWriteTodos(
				{ scope: { kind: "global" }, todos: [{ content: "ad-hoc task", status: "pending" }] },
				TEST_SESSION_ID,
			)
			expect(emitted).toHaveLength(1)
			expect(planEntries(emitted, 0)[0].content).toBe("ad-hoc task")

			// Ferment starts — takes over emission.
			const ferment = makeFerment()
			setActive(ferment)
			simulateBridgePhaseWrite("phase-1")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
			expect(emitted).toHaveLength(2)
			const fermentEntries = planEntries(emitted, 1)
			expect(fermentEntries.some((e) => e.content === "ad-hoc task")).toBe(false)
			expect(fermentEntries[0].content).toBe("[Phase 1] Implementation")
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
			simulateBridgePhaseWrite("phase-1")
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
			simulateBridgePhaseWrite("phase-1")
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
		simulateBridgePhaseWrite("phase-1")
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

	it("does not poison the dedupe key when send() throws", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const bus = createEventBus()
		const emitted: SessionNotification[] = []
		let sendCalls = 0
		const tracker = new AcpPlanTracker({
			sessionId: TEST_SESSION_ID,
			events: bus,
			send: (n) => {
				sendCalls++
				if (sendCalls === 1) throw new Error("transient send failure")
				emitted.push(n)
			},
		})
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
			// The initial emission failed inside send(); the tracker must not
			// treat the plan as emitted.
			expect(emitted).toHaveLength(0)

			// The next store update rebuilds the plan and sends it again — the
			// failed send must not have latched the dedupe key.
			writePhaseTodos("phase-1", [
				{ content: "[Phase 1] Implementation", status: "completed" },
				{ content: "↳ Write the code", status: "completed" },
			])
			expect(sendCalls).toBe(2)
			expect(emitted).toHaveLength(1)
			const entries = planEntries(emitted, 0)
			expect(entries[0].status).toBe("completed")
		} finally {
			tracker.stop()
		}
	})

	it("start() is idempotent — a second start() does not double-subscribe", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const { bus, emitted, tracker } = makeHarness()
		tracker.start()
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
			expect(emitted).toHaveLength(1)
		} finally {
			tracker.stop()
		}
	})

	it("a throwing onActivePlanChanged callback does not break emission", () => {
		const ferment = makeFerment()
		setActive(ferment)
		const bus = createEventBus()
		const emitted: SessionNotification[] = []
		const tracker = new AcpPlanTracker({
			sessionId: TEST_SESSION_ID,
			events: bus,
			send: (n) => emitted.push(n),
			onActivePlanChanged: () => {
				throw new Error("mirror callback failure")
			},
		})
		tracker.start()
		try {
			simulateBridgePhaseWrite("phase-1")
			// bus.emit must not propagate the callback failure, and the plan
			// sessionUpdate must still reach the client.
			expect(() => bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))).not.toThrow()
			expect(emitted).toHaveLength(1)
		} finally {
			tracker.stop()
		}
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
			simulateBridgePhaseWrite("phase-1")
			bus.emit(FERMENT_EVENTS.PHASE_STARTED, phaseStartedPayload(ferment, "phase-1"))
			expect(emitted).toHaveLength(1)
			expect(getterCalled).toBeGreaterThan(0)
		} finally {
			tracker.stop()
		}
	})
})
