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

/**
 * Strict recognition guard for a persisted settle payload. The write sites
 * pin the shape at BashBackgroundSettleData, but transcripts are untrusted
 * IO, so every consumer validates before consuming (details is forwarded
 * as-is, mirroring the BashBackgroundSettleOutcome contract). Shared by the
 * ACP replay (modes/acp/server.ts) and the unsettled-handoffs reconcile so
 * a partial/corrupt settle is ignored consistently on both paths — before
 * this was shared, the reconcile accepted any CustomEntry with a string
 * toolCallId while replay required the full outcome shape.
 */
export function isBashBackgroundSettleData(data: unknown): data is BashBackgroundSettleData {
	if (!data || typeof data !== "object") return false
	const d = data as { toolCallId?: unknown; isError?: unknown; text?: unknown }
	return typeof d.toolCallId === "string" && typeof d.isError === "boolean" && typeof d.text === "string"
}

/**
 * Handoff detection on a typed tool-result `details` payload: `handoff ===
 * true` plus a live registry handle (BackgroundBashToolDetails). The shape
 * is the extension's own contract and details is untyped at the consumers'
 * trust boundaries, so the predicate — not a cast — is what recognizes the
 * shape. Shared by the ACP tool-call module (which receives the result and
 * reads .details off it) and the unsettled-handoffs reconcile (which reads
 * session-entry details directly): handoff recognition must not drift
 * between the live path and the transcript reconcile.
 */
export function backgroundHandoffHandleFromDetails(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined
	const { handoff, handle } = details as { handoff?: unknown; handle?: unknown }
	if (handoff !== true || typeof handle !== "string" || handle.length === 0) return undefined
	return handle
}
