import type { FakeModel } from "./fake-openai-server.js"

/**
 * Shared backend model catalog exercising duplicate display names across
 * providers (`kimchi-dev` via `ai-enabler` and `kimchi-dev/upstream` via
 * `upstream`), alongside a unique display name and Auto.
 */
export const PROVIDER_CATALOG: FakeModel[] = [
	{
		slug: "auto",
		displayName: "Auto",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	{
		slug: "shared",
		displayName: "Shared Model",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	{
		slug: "shared",
		displayName: "Shared Model",
		provider: "upstream",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
	{
		slug: "plain",
		displayName: "Plain Model",
		provider: "upstream",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
	},
]
