import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { vi } from "vitest"

export function createModel(id: string, provider = "kimchi-dev"): Model<Api> {
	return {
		id,
		provider,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	}
}

export function createModelRegistry(models: Model<Api>[] = []) {
	return {
		refresh: vi.fn<ModelRegistry["refresh"]>().mockResolvedValue({ aborted: false, errors: new Map() }),
		find: vi.fn((provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id)),
		getAvailable: vi.fn(() => models),
		getApiKeyAndHeaders: vi.fn<ModelRegistry["getApiKeyAndHeaders"]>().mockResolvedValue({
			ok: true,
			apiKey: "test-key",
			headers: {},
		}),
		hasConfiguredAuth: vi.fn<ModelRegistry["hasConfiguredAuth"]>(() => true),
	}
}
