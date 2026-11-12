/**
 * Persisted settle record for a held background bash call.
 *
 * A backgrounded bash tool result is a pre-exit handoff, not the outcome.
 * When the process exits, the terminal fact is persisted as a
 * metadata-only CustomEntry under BASH_BACKGROUND_SETTLE_MESSAGE_TYPE: it
 * never enters model context and never triggers a turn, but without it a
 * reload replays the call from its recorded pre-exit handoff result as if
 * that were the final outcome.
 *
 * In shared/ because two layers consume the shape — the ACP server writes
 * and replays settles, the bash-background extension reconciles unsettled
 * handoffs on session_start — and importing modes/acp from the extension
 * would close an extension→mode→extension cycle.
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
