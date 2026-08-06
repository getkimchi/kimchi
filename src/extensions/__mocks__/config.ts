import type { KimchiConfig } from "../../config.js"

export function createKimchiConfig(overrides: Partial<KimchiConfig> = {}): KimchiConfig {
	return {
		apiKey: "",
		agentConfigDir: "/tmp/kimchi-agent",
		llmEndpoint: "https://llm.test.invalid/v1",
		customLlmEndpoint: undefined,
		maxToolResultChars: 50_000,
		mcpSearchLimit: 20,
		mcpSearch: {
			strategy: "bm25",
			bm25K1: 1.2,
			bm25B: 0.75,
			fieldWeights: { name: 6, description: 2, schemaKey: 1 },
		},
		onboarding: {},
		deviceId: "test-device",
		...overrides,
	}
}
