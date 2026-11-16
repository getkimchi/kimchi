import type { FakeModel } from "./fake-openai-server.js"

export const PROVIDER_CATALOG: FakeModel[] = [
	{ slug: "auto", displayName: "Auto", provider: "ai-enabler", reasoning: true },
	{
		slug: "shared",
		displayName: "Shared Model",
		provider: "ai-enabler",
		reasoning: true,
		metadata: { thinking_levels: ["low", "high", "max"] },
	},
	{
		slug: "shared",
		displayName: "Shared Model",
		provider: "upstream",
		reasoning: true,
		metadata: { thinking_levels: [] },
	},
	{ slug: "plain", displayName: "Plain Model", provider: "upstream", reasoning: false },
].map((model) => ({ ...model, contextWindow: 128_000 }))
