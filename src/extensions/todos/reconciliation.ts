/**
 * Feature-local reconciliation bookkeeping shared by the closure steer
 * (index.ts) and the check-in gate (checkin-gate.ts).
 *
 * "Reconciliation" = the model (or the user, via a /todos command) took a
 * real look at a scope's list against the user's latest direction and
 * either rewrote it or — once the gate lands — explicitly confirmed it.
 * Background lifecycle writes (the ferment bridge) and no-op marks do not
 * reconcile.
 *
 * All state here is volatile: it never touches the persisted todo state
 * block (#1166 cache-stability contract) and is disposed with its session.
 */
import { getOrCreateInnerMap } from "./nested-maps.js"
import { getTodoScopeKey } from "./scope.js"
import { getTodoScopeVersion, getWorkToolCalls } from "./store.js"
import type { TodoScope } from "./types.js"

/** Latest received user-input revision per session. Advanced on every
 *  genuine user message (interactive or rpc source — never extension
 *  injections, reminders, or replayed history) via the SDK input event —
 *  receive semantics, not acceptance; see todos/index.ts. */
const inputRevisions = new Map<string, number>()

/** Advance and return the session's input revision (newest received input). */
export function advanceInputRevision(sessionId: string): number {
	const next = (inputRevisions.get(sessionId) ?? 0) + 1
	inputRevisions.set(sessionId, next)
	return next
}

/** Current input revision for the session (0 before any user input). */
export function getInputRevision(sessionId: string): number {
	return inputRevisions.get(sessionId) ?? 0
}

/** A scope's last proven reconciliation. */
export interface ScopeReconciliationRecord {
	/** Input revision the reconciliation acknowledged. */
	inputRevision: number
	/** Scope list version at the acknowledgment. */
	listVersion: number
	/** Cumulative successful work-tool count at the acknowledgment. */
	workSequence: number
}

const reconciliations = new Map<string, Map<string, ScopeReconciliationRecord>>()

/** Record that `scope` was reconciled against input `inputRevision`.
 *  Captures the current list version and successful-work sequence so later
 *  drift can be detected: newer input, completed work, or an
 *  unacknowledged write all invalidate the record. */
export function recordScopeReconciliation(scope: TodoScope, sessionId: string, inputRevision: number): void {
	getOrCreateInnerMap(reconciliations, sessionId).set(getTodoScopeKey(scope), {
		inputRevision,
		listVersion: getTodoScopeVersion(scope, sessionId),
		workSequence: getWorkToolCalls(sessionId),
	})
}

/** The scope's latest reconciliation record, if any. */
export function getScopeReconciliation(scope: TodoScope, sessionId: string): ScopeReconciliationRecord | undefined {
	return reconciliations.get(sessionId)?.get(getTodoScopeKey(scope))
}

/** True when the scope's current list was reconciled against the session's
 *  latest accepted user input, and nothing has invalidated that since:
 *  no newer input (which changes what must be reconciled), no successful
 *  work tool completing afterward (which can outpace the list — including
 *  work admitted before the reconciliation but finished after), and no
 *  unacknowledged write (e.g. background lifecycle sync). Used by the
 *  terminal closure steer. */
export function isScopeReconciledForLatestInput(scope: TodoScope, sessionId: string): boolean {
	const record = getScopeReconciliation(scope, sessionId)
	if (!record) return false
	return (
		record.inputRevision === getInputRevision(sessionId) &&
		record.listVersion === getTodoScopeVersion(scope, sessionId) &&
		record.workSequence === getWorkToolCalls(sessionId)
	)
}

/** True when the scope was reconciled against the given input revision and
 *  the list has not changed since (no unacknowledged writes). Work tool
 *  completion does NOT invalidate this — reconciling a list and then
 *  working is the normal flow (unlike the terminal-closure suppression,
 *  which a completed work tool must invalidate). Used by the check-in
 *  gate. */
export function isScopeReconciledForRevision(scope: TodoScope, sessionId: string, inputRevision: number): boolean {
	const record = getScopeReconciliation(scope, sessionId)
	if (!record) return false
	return record.inputRevision === inputRevision && record.listVersion === getTodoScopeVersion(scope, sessionId)
}

/** Replay / session-tree changes invalidate unproven acknowledgments — the
 *  branch content changed under them, so require reconciliation again. */
export function clearScopeReconciliations(sessionId: string): void {
	reconciliations.delete(sessionId)
	admittedInputRevisions.delete(sessionId)
}

/** Input revisions captured when todo tool calls were admitted (at the
 *  tool_call hook). A write acknowledges only the revision that was
 *  accepted when its call was admitted — newer user input arriving while
 *  the call was executing keeps its check pending. */
const admittedInputRevisions = new Map<string, Map<string, number>>()

export function recordAdmittedInputRevision(sessionId: string, toolCallId: string, revision: number): void {
	getOrCreateInnerMap(admittedInputRevisions, sessionId).set(toolCallId, revision)
}

/** Take the admitted revision for a tool call: returns it and deletes the
 *  entry, so the bookkeeping does not grow over a long session — the
 *  revision is consumed exactly once, when the write executes. */
export function takeAdmittedInputRevision(sessionId: string, toolCallId: string): number | undefined {
	const byCall = admittedInputRevisions.get(sessionId)
	if (!byCall) return undefined
	const revision = byCall.get(toolCallId)
	if (revision !== undefined) byCall.delete(toolCallId)
	return revision
}

/** Shutdown disposal: clears all reconciliation state for a session. */
export function disposeSessionReconciliation(sessionId: string): void {
	reconciliations.delete(sessionId)
	admittedInputRevisions.delete(sessionId)
	inputRevisions.delete(sessionId)
}

/** Test-only: reset all bookkeeping. */
export function __resetReconciliationBookkeeping(): void {
	reconciliations.clear()
	inputRevisions.clear()
	admittedInputRevisions.clear()
}
