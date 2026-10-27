/**
 * Check-in gate: pending todo reconciliation per session and scope.
 *
 * Two triggers, one reconciliation mechanism:
 * - `user_input` (routine): genuine user input may change the course of
 *   action, so relevant unfinished lists require reconciliation (a real
 *   write or an explicit confirmation) before further work tools are
 *   admitted. This is a request-boundary check, not a rare escalation, and
 *   is not budget-limited.
 * - `staleness` (escalation): a list that has aged past
 *   CHECKIN_HARD_THRESHOLD work calls while ignoring delivered reminders
 *   escalates to the same gate, bounded by two openings per user request
 *   and one opening per scope write-epoch.
 *
 * Enforcement lives in index.ts (the `tool_call` hook); this module owns
 * the bookkeeping: pending checks, staleness epoch flags, the request-wide
 * opening budget, and change subscriptions for surfaces (widget, ACP plans).
 * All state is volatile and disposed with its session — it never touches
 * the persisted todo state block.
 */
import { getInputRevision, isScopeReconciledForRevision } from "./reconciliation.js"
import { getTodoScopeKey } from "./scope.js"
import { GLOBAL_TODO_SCOPE, getTodosForScope, resolveTodoScope } from "./store.js"
import { TODO_STATUS, type TodoScope } from "./types.js"

/** Work-call count at which a neglected list escalates to the gate. */
export const CHECKIN_HARD_THRESHOLD = 50

/** A delivered reminder at this boundary or later (the stronger wording)
 *  is required before staleness escalation. */
export const CHECKIN_DELIVERED_BOUNDARY_REQUIRED = 30

/** Maximum staleness-gate openings per user request. The routine
 *  user_input check is never budget-limited. */
export const CHECKIN_STALENESS_OPENINGS_PER_REQUEST = 2

export type CheckinReason = "user_input" | "staleness" | "plan_submission"

export interface CheckinPending {
	scope: TodoScope
	reasons: ReadonlySet<CheckinReason>
	/** Input revision the check is pending against. */
	inputRevision: number
}

/** Change notification for surfaces (widget repaint, ACP plan metadata). */
export type CheckinGateChange =
	| { kind: "pending" }
	| { kind: "reconciled"; scope: TodoScope; method: "write" | "confirm"; closed: boolean }
	| { kind: "confirm_mismatch"; scope: TodoScope; method: "mismatch" | "stale_revision" }
	| { kind: "enforcement"; active: boolean }

interface PendingEntry {
	scope: TodoScope
	reasons: Set<CheckinReason>
	inputRevision: number
}

interface SessionGateState {
	pendingByScope: Map<string, PendingEntry>
	/** Scope keys whose staleness gate already opened in this write-epoch. */
	stalenessOpenedEpochs: Set<string>
	/** Staleness openings consumed in the current user request. */
	stalenessOpenings: number
	/** Input revision the opening budget belongs to. */
	stalenessOpeningsRevision: number
	/** Whether enforcement is currently active (resource enabled, kill
	 *  switch off, reconciliation tools available). Pending checks are
	 *  preserved while inactive — only their publication is suppressed, so
	 *  re-enablement re-surfaces the unreconciled input. */
	enforcementActive: boolean
}

const gateStates = new Map<string, SessionGateState>()
const gateListeners = new Set<(sessionId: string, change: CheckinGateChange) => void>()

function sessionState(sessionId: string): SessionGateState {
	let state = gateStates.get(sessionId)
	if (!state) {
		state = {
			pendingByScope: new Map(),
			stalenessOpenedEpochs: new Set(),
			stalenessOpenings: 0,
			stalenessOpeningsRevision: 0,
			enforcementActive: true,
		}
		gateStates.set(sessionId, state)
	}
	return state
}

function notify(sessionId: string, change: CheckinGateChange): void {
	for (const listener of [...gateListeners]) {
		try {
			listener(sessionId, change)
		} catch (error) {
			console.error("Check-in gate listener failed:", error)
		}
	}
}

/** Relevant lists for the check-in gate: the deduplicated global +
 *  active-step set, restricted to lists with unfinished items (pending,
 *  in_progress, or blocked). Empty and fully completed lists, phase lists,
 *  and inactive historical step lists are excluded. */
export function getRelevantCheckinScopes(sessionId: string): TodoScope[] {
	const scopes = new Map<string, TodoScope>()
	scopes.set(getTodoScopeKey(GLOBAL_TODO_SCOPE), GLOBAL_TODO_SCOPE)
	const active = resolveTodoScope(sessionId)
	if (active.kind !== "global") {
		scopes.set(getTodoScopeKey(active), active)
	}
	const result: TodoScope[] = []
	for (const scope of scopes.values()) {
		if (getTodosForScope(scope, sessionId).some((todo) => todo.status !== TODO_STATUS.COMPLETED)) {
			result.push(scope)
		}
	}
	return result
}

/** Mark scopes as requiring reconciliation against `inputRevision`.
 *  Pending checks coalesce per scope; a newer revision supersedes an older
 *  one (confirmation against the older revision cannot unlock work). The
 *  reason distinguishes the trigger for surfaces and telemetry — `user_input`
 *  (a request boundary: new user direction) or `plan_submission` (the
 *  submit_plan handoff: work completed while finalizing the plan is not yet
 *  reflected) — without changing the reconciliation contract. */
export function markCheckinPending(
	scopes: readonly TodoScope[],
	sessionId: string,
	inputRevision: number,
	reason: CheckinReason = "user_input",
): void {
	if (scopes.length === 0) return
	const state = sessionState(sessionId)
	let changed = false
	for (const scope of scopes) {
		const scopeKey = getTodoScopeKey(scope)
		const existing = state.pendingByScope.get(scopeKey)
		if (existing) {
			if (inputRevision >= existing.inputRevision) {
				if (inputRevision > existing.inputRevision || !existing.reasons.has(reason)) changed = true
				existing.inputRevision = inputRevision
				existing.reasons.add(reason)
			}
			continue
		}
		state.pendingByScope.set(scopeKey, {
			scope,
			reasons: new Set([reason]),
			inputRevision,
		})
		changed = true
	}
	if (changed) notify(sessionId, { kind: "pending" })
}

/** Add the staleness reason to a scope's pending check. A scope already
 *  pending for user input gets the additional reason without a duplicate
 *  message. */
export function addStalenessPending(scope: TodoScope, sessionId: string, inputRevision: number): void {
	const state = sessionState(sessionId)
	const scopeKey = getTodoScopeKey(scope)
	const existing = state.pendingByScope.get(scopeKey)
	if (existing) {
		existing.reasons.add("staleness")
		existing.inputRevision = Math.max(existing.inputRevision, inputRevision)
	} else {
		state.pendingByScope.set(scopeKey, {
			scope,
			reasons: new Set(["staleness"]),
			inputRevision,
		})
	}
	notify(sessionId, { kind: "pending" })
}

/** Reconcile a scope: closes its pending check when the reconciliation
 *  acknowledges at least the pending input revision (a write admitted
 *  before newer user input cannot satisfy the newer check). Returns
 *  whether a pending check closed.
 *
 *  The method asymmetry is deliberate: a write only publishes when a
 *  check actually closed (its staleness resets ride the store-change
 *  subscribers), while a confirmation always publishes — there is no
 *  store write, so the `reconciled` notification doubles as the trigger
 *  that resets the scope's staleness schedule even when no check was
 *  pending. Confirming an accurate list at call 23 restarts the reminder
 *  cadence just like a write would; only a confirmation against an older
 *  revision than a pending check's is refused (stale acknowledgement). */
export function reconcileCheckinScope(
	scope: TodoScope,
	sessionId: string,
	inputRevision: number,
	method: "write" | "confirm" = "write",
): boolean {
	const state = sessionState(sessionId)
	const scopeKey = getTodoScopeKey(scope)
	const existing = state.pendingByScope.get(scopeKey)
	if (existing && existing.inputRevision > inputRevision) return false
	const closed = existing !== undefined
	if (closed) {
		state.pendingByScope.delete(scopeKey)
		// The write-epoch flag resets with the epoch: a reconciled list may
		// escalate again in a later epoch if it is neglected again.
		state.stalenessOpenedEpochs.delete(scopeKey)
	}
	if (closed || method === "confirm") {
		notify(sessionId, { kind: "reconciled", scope, method, closed })
	}
	return closed
}

/** Report a failed confirmation attempt (wrong expected set, or a stale
 *  input revision). Checks stay pending. */
export function reportConfirmMismatch(
	scope: TodoScope,
	sessionId: string,
	method: "mismatch" | "stale_revision",
): void {
	notify(sessionId, { kind: "confirm_mismatch", scope, method })
}

/** Drop pending entries for scopes that are no longer relevant (the list
 *  was emptied or fully completed). */
export function dropIrrelevantPending(sessionId: string, relevant: readonly TodoScope[]): void {
	const state = sessionState(sessionId)
	if (state.pendingByScope.size === 0) return
	const relevantKeys = new Set(relevant.map((scope) => getTodoScopeKey(scope)))
	let changed = false
	for (const scopeKey of [...state.pendingByScope.keys()]) {
		if (!relevantKeys.has(scopeKey)) {
			state.pendingByScope.delete(scopeKey)
			state.stalenessOpenedEpochs.delete(scopeKey)
			changed = true
		}
	}
	if (changed) notify(sessionId, { kind: "pending" })
}

/** All pending checks for the session. */
export function getPendingCheckins(sessionId: string): CheckinPending[] {
	const state = gateStates.get(sessionId)
	if (!state) return []
	return [...state.pendingByScope.values()].map((entry) => ({
		scope: entry.scope,
		reasons: entry.reasons,
		inputRevision: entry.inputRevision,
	}))
}

/** The pending checks surfaces should publish: the raw checks, but only
 *  while enforcement is active. When enforcement is released (resource
 *  disabled, kill switch, no reconciliation tools) work flows — showing a
 *  pause would be false; the raw checks are preserved for re-enablement. */
export function getEffectivePendingCheckins(sessionId: string): CheckinPending[] {
	const state = gateStates.get(sessionId)
	if (!state?.enforcementActive) return []
	return getPendingCheckins(sessionId)
}

export function hasEffectivePendingCheckin(sessionId: string): boolean {
	return getEffectivePendingCheckins(sessionId).length > 0
}

/** Publish the effective enforcement state for the session. Flips notify
 *  subscribers so the widget and ACP metadata repaint; the raw pending
 *  checks (and their revisions) are preserved either way. */
export function setCheckinEnforcementActive(sessionId: string, active: boolean): void {
	const state = sessionState(sessionId)
	if (state.enforcementActive === active) return
	state.enforcementActive = active
	notify(sessionId, { kind: "enforcement", active })
}

/** True when the scope's list was reconciled against the session's latest
 *  accepted input and has not changed since (work tool completion does not
 *  invalidate it — reconciling then working is the normal flow). */
export function isScopeCheckedIn(scope: TodoScope, sessionId: string): boolean {
	return isScopeReconciledForRevision(scope, sessionId, getInputRevision(sessionId))
}

/** True when the scope currently has a pending check. */
export function isCheckinPending(scope: TodoScope, sessionId: string): boolean {
	return gateStates.get(sessionId)?.pendingByScope.has(getTodoScopeKey(scope)) ?? false
}

// ── Staleness escalation bookkeeping ────────────────────────────────────────

/** True when a staleness gate has already opened for this scope in the
 *  current write-epoch. */
export function hasStalenessGateOpened(scope: TodoScope, sessionId: string): boolean {
	return gateStates.get(sessionId)?.stalenessOpenedEpochs.has(getTodoScopeKey(scope)) ?? false
}

/** Mark that the staleness gate opened for this scope in this epoch. */
export function markStalenessGateOpened(scope: TodoScope, sessionId: string): void {
	sessionState(sessionId).stalenessOpenedEpochs.add(getTodoScopeKey(scope))
}

/** Start a new staleness epoch for a scope (any write or confirmation to
 *  the list re-arms escalation). */
export function resetScopeEpoch(scope: TodoScope, sessionId: string): void {
	const state = gateStates.get(sessionId)
	if (state) state.stalenessOpenedEpochs.delete(getTodoScopeKey(scope))
}

/** True when fewer than CHECKIN_STALENESS_OPENINGS_PER_REQUEST gates have
 *  opened in the user request that `inputRevision` belongs to. A new
 *  request (later revision) resets the budget. */
export function canOpenStalenessGate(sessionId: string, inputRevision: number): boolean {
	const state = sessionState(sessionId)
	if (state.stalenessOpeningsRevision !== inputRevision) return true
	return state.stalenessOpenings < CHECKIN_STALENESS_OPENINGS_PER_REQUEST
}

/** Consume one opening from the request's staleness budget. */
export function recordStalenessOpening(sessionId: string, inputRevision: number): void {
	const state = sessionState(sessionId)
	if (state.stalenessOpeningsRevision !== inputRevision) {
		state.stalenessOpenings = 0
		state.stalenessOpeningsRevision = inputRevision
	}
	state.stalenessOpenings += 1
}

// ── Subscriptions and lifecycle ───────────────────────────────────────────────

export function subscribeCheckinGate(listener: (sessionId: string, change: CheckinGateChange) => void): () => void {
	gateListeners.add(listener)
	return () => {
		gateListeners.delete(listener)
	}
}

/** Replay / branch changes: pending checks and staleness bookkeeping are
 *  rebuilt from the restored state — relevant unfinished lists require
 *  reconciliation before resumed work. Historical messages are not fresh
 *  input (the input revision is not advanced). */
export function handleCheckinReplay(sessionId: string): void {
	gateStates.delete(sessionId)
	notify(sessionId, { kind: "pending" })
}

/** Shutdown disposal: removes all gate state for the session without
 *  affecting other sessions on the same host. */
export function disposeCheckinGateSession(sessionId: string): void {
	gateStates.delete(sessionId)
}

/** Test-only: reset all gate state. */
export function __resetCheckinGate(): void {
	gateStates.clear()
}
