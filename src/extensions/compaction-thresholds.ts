/**
 * Shared compaction threshold constants.
 *
 * This module exists so multiple extensions (model-guard, ferment auto-compaction)
 * agree on the same reserve-tokens value used to decide when context is "full".
 *
 * The value MUST stay in sync with upstream `DEFAULT_COMPACTION_SETTINGS.reserveTokens`
 * (currently 16,384 tokens). If upstream changes, update this constant and the
 * corresponding check in model-guard.ts / ferment/auto-compaction.ts.
 */

/** Tokens reserved as headroom below the model's context window. */
export const COMPACTION_RESERVE_TOKENS = 16_384

/**
 * Error message fragments upstream compaction uses for routine no-op outcomes
 * (session too small, no valid cut point, already compacted, nothing
 * summarizable). These are not failures: callers skip quietly instead of
 * suppressing compaction. Shared with the ferment compaction path so the two
 * cannot drift apart (shape lifted from closed-unmerged PR #1157).
 */
export const EXPECTED_COMPACTION_ERROR_MESSAGES = [
	"Nothing to compact",
	"Already compacted",
	"no summarizable messages",
]

/** True when a compaction rejection is a routine no-op rather than a real failure. */
export function isExpectedCompactionError(message: string): boolean {
	return EXPECTED_COMPACTION_ERROR_MESSAGES.some((expected) => message.includes(expected))
}
