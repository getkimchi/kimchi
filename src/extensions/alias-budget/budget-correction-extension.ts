/**
 * Lifecycle hygiene for the alias-budget corrective-recovery state.
 *
 * The correction store is written at the stream boundary (adapter) and by the
 * retry classifier (patch); this extension clears it at the request-cycle
 * boundaries so state never leaks across requests or sessions:
 *
 * - `message_end` — a terminal non-error assistant message (success,
 *   cancellation/abort, length) closes the request cycle: any pending
 *   correction for the session is dropped.
 * - `session_shutdown` — the session is gone; drop everything.
 *
 * Turn settlement (terminal error, refused retries) is handled by the retry
 * patch's `_handlePostAgentRun` wrapper, NOT here: an `agent_end` handler
 * cannot know whether a retry of the same logical request will follow, so
 * clearing there would discard a mid-flight correction exactly when a
 * transient failure is being retried.
 *
 * Model changes need no event: a pending correction is keyed to the model it
 * was scheduled for, and the adapter refuses to apply it for a different
 * model while the next request overwrites the outgoing-budget record.
 *
 * Registered for parent TUI and ACP sessions (cli.ts factory list) and for
 * child sessions (agent-runner inline list), mirroring
 * `infrastructureBreakerExtension`.
 */

import type { ExtensionAPI, MessageEndEvent } from "@earendil-works/pi-coding-agent"
import { clearBudgetCorrectionState, clearPendingCorrection } from "./budget-correction-store.js"

export default function budgetCorrectionExtension(pi: ExtensionAPI): void {
	pi.on("message_end", (event: MessageEndEvent, ctx) => {
		const message = event.message
		if (message.role !== "assistant") return
		if (message.stopReason === "error") return
		// Success, abort, or a completed (non-error) stop: the request cycle is
		// closed — nothing pending may outlive it.
		clearPendingCorrection(ctx.sessionManager.getSessionId())
	})

	pi.on("session_shutdown", (_event, ctx) => {
		clearBudgetCorrectionState(ctx.sessionManager.getSessionId())
	})
}
