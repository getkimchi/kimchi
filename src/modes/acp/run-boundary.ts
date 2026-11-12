// Run-boundary notification for agent-initiated runs.
//
// ACP v1 has no concept of a run no client prompt owns (today: a
// background-task completion waking an idle agent). These two custom ext
// notifications announce such a run's start (with its reason) and end
// (with its stopReason) so clients can anchor their streaming pipeline.
// Field names deliberately mirror v1's PromptResponse.stopReason, which is
// also what the ACP v2 Background Work RFD calls its idle-state field —
// v2 wraps this in a `state_update` snapshot with a `background` list, so
// the v2 migration will be a RESHAPE into that envelope, not a bare
// rename:
//
//   _kimchi.dev/run_start { sessionId, state: "running", reason }
//   _kimchi.dev/run_end   { sessionId, state: "idle", stopReason }
//
// Clients that don't know the notification ignore it (JSON-RPC
// notifications with unknown methods are no-ops). The reason travels
// through the session-keyed registry in shared/run-reason-registry.js —
// see that module for the hand-off lifetime argument.

import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { RunStartReason } from "../../shared/run-reason-registry.js"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"
import { emitExtNotification } from "./ext-notifications.js"

/** How the agent-initiated run ended. Mirrors the mapped wire value of
 * PromptResponse.stopReason: the v1 literals ("end_turn" | "cancelled" |
 * "refusal" — coarser than the v1 union because max_tokens/max_turn_requests
 * coalesce to end_turn, the same coalescing finalizeTurn applies to
 * prompt-owned turns) plus "error", which v1 has no literal for. */
export type RunEndStopReason = "end_turn" | "cancelled" | "refusal" | "error"

export function emitRunStart(conn: AgentSideConnection, sessionId: string, reason: RunStartReason): void {
	emitExtNotification(conn, AVAILABLE_EXT_NOTIFICATIONS.run_start, { sessionId, state: "running", reason })
}

export function emitRunEnd(conn: AgentSideConnection, sessionId: string, stopReason: RunEndStopReason): void {
	emitExtNotification(conn, AVAILABLE_EXT_NOTIFICATIONS.run_end, { sessionId, state: "idle", stopReason })
}

/** Map a turn's end flags to the run's stopReason, mirroring finalizeTurn's
 *  mapping for prompt-owned turns. Precedence: cancelled > error > refusal
 *  > end_turn. */
export function runStopReasonFromFlags(flags: {
	cancelled?: boolean
	lastAssistantError?: unknown
	refused?: boolean
}): RunEndStopReason {
	if (flags.cancelled) return "cancelled"
	if (flags.lastAssistantError) return "error"
	if (flags.refused) return "refusal"
	return "end_turn"
}
