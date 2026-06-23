/**
 * default: the stock no-op variant.
 *
 * Opening this file shows exactly what the default variant configures: nothing
 * beyond stock. Every field is absent/undefined, so the assembled prompt is
 * byte-for-byte identical to the original when no variant is active.
 *
 * Model posture: uses the stock builtin model roles with no override
 * (modelRoleDefaults is undefined). Role resolution is handled entirely by
 * DEFAULT_MODEL_ROLES in the model-roles module.
 */

import type { PromptVariant } from "./types.js"

// ---------------------------------------------------------------------------
// Config descriptor (the full set of knobs this variant changes)
// ---------------------------------------------------------------------------

/** The no-op default variant: changes nothing beyond stock. */
export const DEFAULT_VARIANT: PromptVariant = {
	name: "default",
	// All other fields are intentionally absent.
	// No intro override, no guidelines, no model role defaults, no discipline reminder.
	// The assembled prompt is byte-for-byte identical to the original.
}
