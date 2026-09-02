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
