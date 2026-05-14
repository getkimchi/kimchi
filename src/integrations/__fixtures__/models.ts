import type { ModelMetadata } from "../../models.js"

/**
 * Shared test fixture for `ModelMetadata[]`. Covers all roles (main, coding,
 * sub, opus, sonnet) so tests can exercise the full role resolution logic
 * without any network calls.
 *
 * Slugs match what the real API returns. Role resolution depends on these
 * exact slugs — if the API changes slugs, update this fixture accordingly.
 */
export const TEST_MODELS: readonly ModelMetadata[] = [
	{
		slug: "kimi-k2.6",
		display_name: "Kimi K2.6",
		provider: "ai-enabler",
		reasoning: true,
		input_modalities: ["text", "image"],
		is_serverless: true,
		limits: { context_window: 262_144, max_output_tokens: 32_768 },
	},
	{
		slug: "kimi-k2.5",
		display_name: "Kimi K2.5",
		provider: "ai-enabler",
		reasoning: true,
		input_modalities: ["text", "image"],
		is_serverless: true,
		limits: { context_window: 262_144, max_output_tokens: 32_768 },
	},
	{
		slug: "nemotron-3-super-fp4",
		display_name: "Nemotron 3 Super FP4",
		provider: "ai-enabler",
		reasoning: true,
		input_modalities: ["text"],
		is_serverless: true,
		limits: { context_window: 1_048_576, max_output_tokens: 256_000 },
	},
	{
		slug: "minimax-m2.7",
		display_name: "MiniMax M2.7",
		provider: "ai-enabler",
		reasoning: true,
		input_modalities: ["text"],
		is_serverless: true,
		limits: { context_window: 196_608, max_output_tokens: 32_768 },
	},
	{
		slug: "claude-opus-4-7",
		display_name: "Claude Opus 4.7",
		provider: "anthropic",
		reasoning: true,
		input_modalities: ["text"],
		is_serverless: false,
		limits: { context_window: 1_000_000, max_output_tokens: 128_000 },
	},
	{
		slug: "claude-sonnet-4-7",
		display_name: "Claude Sonnet 4.7",
		provider: "anthropic",
		reasoning: true,
		input_modalities: ["text"],
		is_serverless: false,
		limits: { context_window: 1_000_000, max_output_tokens: 128_000 },
	},
]

/** Subset containing only serverless models — for role resolution tests. */
export const TEST_SERVERLESS_MODELS = TEST_MODELS.filter((m) => m.is_serverless)

/** Subset containing only Anthropic models — for opus/sonnet tests. */
export const TEST_ANTHROPIC_MODELS = TEST_MODELS.filter((m) => m.provider === "anthropic")
