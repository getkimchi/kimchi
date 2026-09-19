/**
 * default: the stock no-op variant, used when no variant is selected.
 */

import type { PromptVariant } from "./types.js"

// ---------------------------------------------------------------------------
// Config descriptor (the full set of knobs this variant changes)
// ---------------------------------------------------------------------------

/** The no-op default variant: changes nothing beyond stock. */
export const DEFAULT_VARIANT: PromptVariant = {
	name: "default",
	// Every other field is intentionally absent, so the assembled prompt stays
	// byte-for-byte identical to the original.
}
