// Run-boundary notification for agent-initiated runs.
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
// notifications with unknown methods are no-ops). The reason travels
// through the process-wide registry in shared/run-reason-registry.js —
// see that module for the single-slot lifetime argument.

import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type { RunStartReason } from "../../shared/run-reason-registry.js"
import { AVAILABLE_EXT_NOTIFICATIONS } from "./capabilities.js"
import { emitExtNotification } from "./ext-notifications.js"

/** How the agent-initiated run ended, mirroring PromptResponse.stopReason. */
export type RunEndOutcome = "end_turn" | "cancelled" | "refusal" | "error"

export function emitRunStart(conn: AgentSideConnection, sessionId: string, reason: RunStartReason): void {
	emitExtNotification(conn, AVAILABLE_EXT_NOTIFICATIONS.run_start, { sessionId, state: "running", reason })
}

export function emitRunEnd(conn: AgentSideConnection, sessionId: string, outcome: RunEndOutcome): void {
	emitExtNotification(conn, AVAILABLE_EXT_NOTIFICATIONS.run_end, { sessionId, state: "idle", outcome })
}

/** Map a turn's end flags to the run-outcome, mirroring finalizeTurn's
 *  stopReason mapping for prompt-owned turns. Precedence: cancelled > error
 *  > refusal > end_turn. */
export function runEndOutcomeFromFlags(flags: {
	cancelled?: boolean
	lastAssistantError?: unknown
	refused?: boolean
}): RunEndOutcome {
	if (flags.cancelled) return "cancelled"
	if (flags.lastAssistantError) return "error"
	if (flags.refused) return "refusal"
	return "end_turn"
}
