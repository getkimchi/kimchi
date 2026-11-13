/**
 * Persisted settle record for a held background bash call — owner module.
 *
 * A backgrounded bash tool result is a pre-exit HANDOFF, not the outcome
 * (see extensions/bash-background). When the process exits, the terminal
 * fact is persisted to the session transcript as a metadata-only CustomEntry
 * (`type: "custom"` under BASH_BACKGROUND_SETTLE_MESSAGE_TYPE): a recorded
 * FACT for future replays — it never enters model context and never triggers
 * or steers a turn. The wire flip alone would be ephemeral: without this
 * entry, a reload replays the call from its recorded PRE-EXIT handoff
 * result — a failed process restarting to "completed".
 *
 * Lives in shared/ (not modes/acp/tool-calls/background.ts, where the record
 * originated) because TWO layers consume the shape: the ACP server writes
 * and replays settles, and the bash-background extension reconciles
 * unsettled handoffs on session_start. Importing the ACP module from the
 * extension would close an extension→mode→extension import cycle. Same
 * dependency-free argument as shared/run-reason-registry.js.
 */

import type { BackgroundBashToolDetails } from "../extensions/bash-background/bash-background-tool.js"

/** Custom transcript message type carrying a held call's settle outcome. */
export const BASH_BACKGROUND_SETTLE_MESSAGE_TYPE = "bash-background-settle"

/** Terminal settle fact persisted to the transcript. */
export type BashBackgroundSettleOutcome = {
	/** exitCode 0 with no stop reason reads as success; anything else failed. */
	isError: boolean
	/** Captured final output (empty when the process produced none). */
	text: string
	/** Terminal BackgroundBashToolDetails — the same shape the wire flip sends. */
	details: BackgroundBashToolDetails
}

/** Persisted payload of a settle CustomEntry: the outcome plus the pi
 *  toolCallId of the held call it settles. */
export interface BashBackgroundSettleData extends BashBackgroundSettleOutcome {
	toolCallId: string
}
