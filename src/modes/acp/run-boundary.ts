// Run-boundary notification for agent-initiated runs (LLM-4486).
//
// ACP v1 has no concept of a run no client prompt owns (today: a
// background-task completion waking an idle agent). These two custom ext
// notifications announce such a run's start (with its reason) and end
// (with its outcome) so clients can anchor their streaming pipeline. The
// payloads are field-shaped after the ACP v2 Background Work RFD — where
// the equivalent is the `state_update` session transition in the same
// snapshot that removes the background item — so the v2 migration is a
// rename, not a redesign:
//
//   _kimchi.dev/run_start { sessionId, state: "running", reason }
//   _kimchi.dev/run_end   { sessionId, state: "idle", outcome }
//
// Clients that don't know the notification ignore it (JSON-RPC
// notifications with unknown methods are no-ops).
//
// The extension that WAKES the agent registers the reason right before
// triggering the turn (registerUnsolicitedRunReason); the ACP server
// consumes it at the run's first agent_start (takePendingRunReason).
// Registration and consumption happen on the same process's event loop —
// the extension's sendMessage and the resulting agent_start share one
// tick, so a process-wide (not session-keyed) slot cannot cross sessions.
// A TTL guards the no-wake path (a triggerTurn suppressed by a cancelled
// run): its reason must not mislabel a later, unrelated run.

import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import { emitExtNotification } from "./ext-notifications.js"

export const RUN_START_METHOD = "_kimchi.dev/run_start"
export const RUN_END_METHOD = "_kimchi.dev/run_end"

/** Why the agent started a run no client prompt owns. Known today:
 *  background-task-complete (a background-bash exit woke the idle agent);
 *  anything the server cannot attribute falls back to "agent-initiated". */
export type RunStartReason = "background-task-complete" | "agent-initiated"

/** How the agent-initiated run ended, mirroring PromptResponse.stopReason. */
export type RunEndOutcome = "end_turn" | "cancelled" | "refusal" | "error"

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

export function emitRunStart(conn: AgentSideConnection, sessionId: string, reason: RunStartReason): void {
	emitExtNotification(conn, RUN_START_METHOD, { sessionId, state: "running", reason })
}

export function emitRunEnd(conn: AgentSideConnection, sessionId: string, outcome: RunEndOutcome): void {
	emitExtNotification(conn, RUN_END_METHOD, { sessionId, state: "idle", outcome })
}

/** Map a turn's end flags to the run-outcome, mirroring finalizeTurn's
 *  stopReason mapping for prompt-owned turns. Precedence: cancelled > error
 *  > refusal > end_turn. */
export function runEndOutcomeFromFlags(flags: {
	cancelled?: boolean
	lastAssistantError: unknown
	refused?: boolean
}): RunEndOutcome {
	if (flags.cancelled) return "cancelled"
	if (flags.lastAssistantError) return "error"
	if (flags.refused) return "refusal"
	return "end_turn"
}
