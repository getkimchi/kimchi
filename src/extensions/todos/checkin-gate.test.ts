import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	__resetCheckinGate,
	addStalenessPending,
	CHECKIN_STALENESS_OPENINGS_PER_REQUEST,
	canOpenStalenessGate,
	disposeCheckinGateSession,
	dropIrrelevantPending,
	getEffectivePendingCheckins,
	getPendingCheckins,
	handleCheckinReplay,
	hasEffectivePendingCheckin,
	hasStalenessGateOpened,
	markCheckinPending,
	markStalenessGateOpened,
	reconcileCheckinScope,
	recordStalenessOpening,
	reportConfirmMismatch,
	resetScopeEpoch,
	setCheckinEnforcementActive,
	subscribeCheckinGate,
} from "./checkin-gate.js"
import { __resetReconciliationBookkeeping } from "./reconciliation.js"
import { __resetTodoStore, GLOBAL_TODO_SCOPE } from "./store.js"
import type { TodoScope } from "./types.js"

const STEP_SCOPE: TodoScope = { kind: "ferment-step", phaseId: "p1", stepId: "s1" }

describe("check-in gate bookkeeping", () => {
	beforeEach(() => {
		__resetTodoStore()
		__resetReconciliationBookkeeping()
		__resetCheckinGate()
	})

	it("coalesces pending checks per scope with superseding revisions", () => {
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 1)
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 2)
		markCheckinPending([STEP_SCOPE], "s", 2)

		const pending = getPendingCheckins("s")
		expect(pending).toHaveLength(2)
		const global = pending.find((check) => check.scope.kind === "global")
		expect(global?.inputRevision).toBe(2)
		expect([...(global?.reasons ?? [])]).toEqual(["user_input"])
	})

	it("adds the staleness reason to an existing pending scope without duplicates", () => {
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 1)
		addStalenessPending(GLOBAL_TODO_SCOPE, "s", 1)

		const pending = getPendingCheckins("s")
		expect(pending).toHaveLength(1)
		expect([...pending[0].reasons].sort()).toEqual(["staleness", "user_input"])
	})

	it("reconcile closes only when acknowledging at least the pending revision", () => {
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 3)

		// A write admitted before newer input cannot satisfy the newer check.
		expect(reconcileCheckinScope(GLOBAL_TODO_SCOPE, "s", 2)).toBe(false)
		expect(getPendingCheckins("s")).toHaveLength(1)

		expect(reconcileCheckinScope(GLOBAL_TODO_SCOPE, "s", 3)).toBe(true)
		expect(getPendingCheckins("s")).toHaveLength(0)

		// Reconciling again is a no-op.
		expect(reconcileCheckinScope(GLOBAL_TODO_SCOPE, "s", 4)).toBe(false)
	})

	it("reconcile by confirm closes the check and resets the epoch flag", () => {
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 1)
		markStalenessGateOpened(GLOBAL_TODO_SCOPE, "s")

		const changes: string[] = []
		const unsubscribe = subscribeCheckinGate((_sessionId, change) => changes.push(change.kind))
		try {
			expect(reconcileCheckinScope(GLOBAL_TODO_SCOPE, "s", 1, "confirm")).toBe(true)
		} finally {
			unsubscribe()
		}

		expect(changes).toEqual(["reconciled"])
		expect(getPendingCheckins("s")).toHaveLength(0)
		expect(hasStalenessGateOpened(GLOBAL_TODO_SCOPE, "s")).toBe(false)
	})

	it("a confirmation without a pending check still notifies, resetting the schedule", () => {
		const changes: string[] = []
		const unsubscribe = subscribeCheckinGate((_sessionId, change) => changes.push(change.kind))
		try {
			// No pending check: nothing closes (false), but the reconciled
			// notification still fires — the staleness schedule must reset like
			// it does for a write.
			expect(reconcileCheckinScope(GLOBAL_TODO_SCOPE, "s", 1, "confirm")).toBe(false)
		} finally {
			unsubscribe()
		}
		expect(changes).toEqual(["reconciled"])
	})

	it("confirm mismatches notify without closing anything", () => {
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 1)
		const changes: string[] = []
		const unsubscribe = subscribeCheckinGate((_sessionId, change) => changes.push(change.kind))
		try {
			reportConfirmMismatch(GLOBAL_TODO_SCOPE, "s", "mismatch")
			reportConfirmMismatch(GLOBAL_TODO_SCOPE, "s", "stale_revision")
		} finally {
			unsubscribe()
		}

		expect(changes).toEqual(["confirm_mismatch", "confirm_mismatch"])
		expect(getPendingCheckins("s")).toHaveLength(1)
	})

	it("drops pending entries for scopes that are no longer relevant", () => {
		markCheckinPending([GLOBAL_TODO_SCOPE, STEP_SCOPE], "s", 1)
		dropIrrelevantPending("s", [GLOBAL_TODO_SCOPE])

		expect(getPendingCheckins("s").map((check) => check.scope)).toEqual([GLOBAL_TODO_SCOPE])
	})

	it("isolates pending checks between sessions and disposes per session", () => {
		markCheckinPending([GLOBAL_TODO_SCOPE], "a", 1)
		markCheckinPending([GLOBAL_TODO_SCOPE], "b", 1)

		disposeCheckinGateSession("a")
		expect(getPendingCheckins("a")).toHaveLength(0)
		expect(getPendingCheckins("b")).toHaveLength(1)
	})

	it("staleness epoch flags are per scope and reset on writes to that scope", () => {
		markStalenessGateOpened(GLOBAL_TODO_SCOPE, "s")
		expect(hasStalenessGateOpened(GLOBAL_TODO_SCOPE, "s")).toBe(true)
		expect(hasStalenessGateOpened(STEP_SCOPE, "s")).toBe(false)

		resetScopeEpoch(GLOBAL_TODO_SCOPE, "s")
		expect(hasStalenessGateOpened(GLOBAL_TODO_SCOPE, "s")).toBe(false)
	})

	it("the opening budget caps at two per request and resets on a new request", () => {
		expect(canOpenStalenessGate("s", 1)).toBe(true)
		recordStalenessOpening("s", 1)
		recordStalenessOpening("s", 1)
		expect(canOpenStalenessGate("s", 1)).toBe(false)
		expect(CHECKIN_STALENESS_OPENINGS_PER_REQUEST).toBe(2)

		// A new user request resets the budget.
		expect(canOpenStalenessGate("s", 2)).toBe(true)
	})

	it("closing a pending check does not erase the opening budget", () => {
		recordStalenessOpening("s", 1)
		recordStalenessOpening("s", 1)
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 1)

		expect(reconcileCheckinScope(GLOBAL_TODO_SCOPE, "s", 1)).toBe(true)
		expect(getPendingCheckins("s")).toHaveLength(0)
		expect(canOpenStalenessGate("s", 1)).toBe(false)
	})

	it("replay clears pending checks, epoch flags, and budgets", () => {
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 1)
		markStalenessGateOpened(GLOBAL_TODO_SCOPE, "s")
		recordStalenessOpening("s", 1)

		handleCheckinReplay("s")

		expect(getPendingCheckins("s")).toHaveLength(0)
		expect(hasStalenessGateOpened(GLOBAL_TODO_SCOPE, "s")).toBe(false)
		// The budget belongs to the request revision, which replay does not
		// advance (historical messages are not fresh input).
		expect(canOpenStalenessGate("s", 1)).toBe(true)
	})

	it("enforcement release suppresses publication but preserves the raw checks", () => {
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 1)
		expect(hasEffectivePendingCheckin("s")).toBe(true)

		const changes: string[] = []
		const unsubscribe = subscribeCheckinGate((_sessionId, change) => changes.push(change.kind))
		try {
			setCheckinEnforcementActive("s", false)
		} finally {
			unsubscribe()
		}
		expect(changes).toEqual(["enforcement"])
		// Surfaces see no pause while work flows…
		expect(hasEffectivePendingCheckin("s")).toBe(false)
		expect(getEffectivePendingCheckins("s")).toEqual([])
		// …but the unreconciled check is preserved for re-enablement.
		expect(getPendingCheckins("s")).toHaveLength(1)

		// No-op flips do not notify.
		const notified = [...changes]
		setCheckinEnforcementActive("s", false)
		expect(changes).toEqual(notified)

		setCheckinEnforcementActive("s", true)
		expect(hasEffectivePendingCheckin("s")).toBe(true)
	})

	it("notifies subscribers when pending state changes", () => {
		const listener = vi.fn()
		const unsubscribe = subscribeCheckinGate(listener)

		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 1)
		expect(listener).toHaveBeenCalledTimes(1)

		// No-op marks (same revision, same reason) do not notify.
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 1)
		expect(listener).toHaveBeenCalledTimes(1)

		unsubscribe()
		markCheckinPending([GLOBAL_TODO_SCOPE], "s", 2)
		expect(listener).toHaveBeenCalledTimes(1)
	})
})
