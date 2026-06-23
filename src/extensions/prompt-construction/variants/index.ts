/**
 * Prompt-variant registry and resolver.
 *
 * The active variant is chosen by the `KIMCHI_PROMPT_VARIANT` environment
 * variable. Unset / unknown / "default" resolves to the no-op DEFAULT_VARIANT,
 * which leaves the assembled prompt byte-for-byte identical to the original.
 *
 * Adding a new variant:
 *   1. Create a sibling file (e.g. src/extensions/prompt-construction/variants/my-variant.ts)
 *      with the config descriptor at the top, following the same pattern as spicy.ts.
 *   2. Import and register it in REGISTRY below.
 *   3. That is it: resolver, env-var lookup, and fallback are handled here.
 */

import { DEFAULT_VARIANT } from "./default.js"
import { SPICY } from "./spicy.js"
import type { PromptVariant } from "./types.js"

export type { PromptVariant, VariantBlock } from "./types.js"
export { DEFAULT_VARIANT } from "./default.js"

export const PROMPT_VARIANT_ENV = "KIMCHI_PROMPT_VARIANT"

/** Registry of all non-default variants, keyed by their stable name. */
const REGISTRY: Record<string, PromptVariant> = {
	[SPICY.name]: SPICY,
}

/**
 * Resolve the active prompt variant.
 *
 * @param name Explicit variant name (used by tests). When omitted, the
 *   `KIMCHI_PROMPT_VARIANT` env var is consulted. Unknown names fall back to
 *   the default no-op variant.
 */
export function resolvePromptVariant(name?: string): PromptVariant {
	const key = (name ?? process.env[PROMPT_VARIANT_ENV] ?? "").trim()
	if (!key || key === DEFAULT_VARIANT.name) return DEFAULT_VARIANT
	return REGISTRY[key] ?? DEFAULT_VARIANT
}
