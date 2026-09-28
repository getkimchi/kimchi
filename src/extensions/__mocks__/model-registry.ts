import type { Api, Model } from "@earendil-works/pi-ai"
import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import type { Mock } from "vitest"
import { vi } from "vitest"

/** Registry mock whose commonly-asserted members stay spyable (`.mock…`). */
export type ModelRegistryMock = ModelRegistry & {
	find: Mock<ModelRegistry["find"]>
	getAll: Mock<ModelRegistry["getAll"]>
	getAvailable: Mock<ModelRegistry["getAvailable"]>
	hasConfiguredAuth: Mock<ModelRegistry["hasConfiguredAuth"]>
	getApiKeyAndHeaders: Mock<ModelRegistry["getApiKeyAndHeaders"]>
}

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

export function createModelRegistry(models: Model<Api>[] = []): ModelRegistryMock {
	// Every public member is stubbed, but ModelRegistry has a private `runtime`
	// field, so a plain object can never structurally satisfy the class type —
	// this is the only place that cast may live.
	const registry = {
		refresh: vi.fn<ModelRegistry["refresh"]>().mockResolvedValue({ aborted: false, errors: new Map() }),
		getError: vi.fn(),
		getAll: vi.fn(() => models),
		getAvailable: vi.fn(() => models),
		find: vi.fn((provider: string, modelId: string) => models.find((m) => m.provider === provider && m.id === modelId)),
		hasConfiguredAuth: vi.fn(() => true),
		getApiKeyAndHeaders: vi.fn<ModelRegistry["getApiKeyAndHeaders"]>().mockResolvedValue({
			ok: true,
			apiKey: "test-key",
			headers: {},
		}),
		getProviderAuthStatus: vi.fn<ModelRegistry["getProviderAuthStatus"]>(),
		getProvider: vi.fn<ModelRegistry["getProvider"]>(),
		// vi.fn cannot reproduce the generic/overloaded signatures, and tests
		// never assert on these — plain never-arg stubs satisfy both.
		complete: (..._args: never[]) => Promise.reject(new Error("ModelRegistry.complete is not stubbed")),
		getProviderDisplayName: vi.fn((provider: string) => provider),
		getProviderAuth: vi.fn<ModelRegistry["getProviderAuth"]>(),
		getApiKeyForProvider: vi.fn<ModelRegistry["getApiKeyForProvider"]>(),
		isUsingOAuth: vi.fn(() => false),
		registerProvider: (..._args: never[]) => undefined,
		unregisterProvider: vi.fn<ModelRegistry["unregisterProvider"]>(),
		getRegisteredProviderConfig: vi.fn<ModelRegistry["getRegisteredProviderConfig"]>(),
		getRegisteredNativeProvider: vi.fn<ModelRegistry["getRegisteredNativeProvider"]>(),
		getRegisteredProviderIds: vi.fn(() => [] as string[]),
	}
	return registry as unknown as ModelRegistryMock
}
