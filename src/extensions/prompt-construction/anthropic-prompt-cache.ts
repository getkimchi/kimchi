/**
 * Anthropic prompt caching for the static system prompt.
 *
 * The assembled system prompt (intro, orchestration instructions, guidelines,
 * tools) is large and identical across every turn of a session. Anthropic bills
 * a cache read at ~10% of the normal input price, so marking the static prefix
 * with a `cache_control` breakpoint turns that repeated prefix from full-price
 * input into a cache hit on every turn after the first.
 *
 * The model's Anthropic capability is read from the existing `compat` signal set
 * in `src/models.ts` (`cacheControlFormat: "anthropic"`), so no new model
 * metadata is introduced — non-Anthropic models simply get an unmarked block.
 */

/** Minimal structural view of a model — only the fields cache detection needs. */
export interface AnthropicCacheModel {
	compat?: { cacheControlFormat?: "anthropic" }
}

/** Anthropic ephemeral cache breakpoint, attached to the block it should cache up to. */
export interface CacheControl {
	type: "ephemeral"
}

/** An Anthropic system content block, optionally carrying a cache breakpoint. */
export interface SystemTextBlock {
	type: "text"
	text: string
	cache_control?: CacheControl
}

/**
 * True when the model accepts Anthropic-style `cache_control` breakpoints. Driven
 * by the `compat.cacheControlFormat` flag that `metadataToModel` already stamps on
 * Anthropic models, so this stays the single source of truth for the format.
 */
export function supportsAnthropicPromptCache(model: AnthropicCacheModel | undefined): boolean {
	return model?.compat?.cacheControlFormat === "anthropic"
}

/**
 * Convert an assembled system prompt string into Anthropic system content blocks.
 *
 * For Anthropic-capable models the single static block carries an ephemeral
 * `cache_control` breakpoint so the whole system prefix is cached and replayed at
 * cache-read price on subsequent turns. For every other model the block is
 * returned unmarked, leaving behaviour unchanged. An empty prompt yields no blocks.
 */
export function toCachedSystemBlocks(
	systemPrompt: string,
	model: AnthropicCacheModel | undefined,
): SystemTextBlock[] {
	if (systemPrompt.length === 0) return []
	const block: SystemTextBlock = { type: "text", text: systemPrompt }
	if (supportsAnthropicPromptCache(model)) block.cache_control = { type: "ephemeral" }
	return [block]
}
