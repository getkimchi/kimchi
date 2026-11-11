// Reason hand-off for agent-initiated runs — runs no client prompt owns
// (today: a background-task completion waking an idle agent).
//
// The extension that WAKES the agent registers the reason right before
// triggering the turn (registerUnsolicitedRunReason); the ACP server
// consumes it at the run's first agent_start (takePendingRunReason).
// Registration and consumption happen on the same process's event loop —
// the extension's sendMessage and the resulting agent_start share one
// tick, so a process-wide (not session-keyed) slot cannot cross sessions.
// A TTL guards the no-wake path (a triggerTurn suppressed by a cancelled
// run): its reason must not mislabel a later, unrelated run.
//
// This module is deliberately dependency-free: it is the seam between the
// mode-agnostic extension layer (src/extensions/) and the ACP server's
// run-boundary emitter (src/modes/acp/run-boundary.js), so importing it
// from either side must not pull mode-specific code into the other.
// Mode-agnostic placement mirrors shared/planning/.

/** Why the agent started a run no client prompt owns. Known today:
 *  background-task-complete (a background-bash exit woke the idle agent);
 *  anything the server cannot attribute falls back to "agent-initiated". */
export type RunStartReason = "background-task-complete" | "agent-initiated"

interface PendingReason {
	reason: RunStartReason
	at: number
}

const PENDING_REASON_TTL_MS = 5_000

let pendingReason: PendingReason | undefined

/** Register the reason for the next run start. Call immediately before the
 *  sendMessage that may wake the idle agent; the next agent_start consumes
 *  it (for prompt-owned starts the entry is simply discarded). */
export function registerUnsolicitedRunReason(reason: RunStartReason): void {
	pendingReason = { reason, at: Date.now() }
}

/** Consume (and clear) the pending reason. A reason older than the TTL is
 *  a stale leftover of a suppressed wake and is discarded. */
export function takePendingRunReason(): RunStartReason {
	const pending = pendingReason
	pendingReason = undefined
	if (!pending) return "agent-initiated"
	return Date.now() - pending.at > PENDING_REASON_TTL_MS ? "agent-initiated" : pending.reason
}
