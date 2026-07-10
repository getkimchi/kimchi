/**
 * default: the stock no-op variant.
 *
 * Opening this file shows exactly what the default variant configures: nothing
 * beyond stock. Every field is absent/undefined, so the assembled prompt is
 * byte-for-byte identical to the original when no variant is active.
 */

import type { PromptVariant } from "./types.js"

// ---------------------------------------------------------------------------
// Config descriptor (the full set of knobs this variant changes)
// ---------------------------------------------------------------------------

/** The no-op default variant: changes nothing beyond stock. */
export const DEFAULT_VARIANT: PromptVariant = {
	name: "default",
	// All other fields are intentionally absent.
	// No intro override, no guidelines, no discipline reminder.
	// The assembled prompt is byte-for-byte identical to the original.
}
