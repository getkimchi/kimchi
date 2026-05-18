import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "./model-registry/index.js"
import { resolveOrchestrationInstructions } from "./orchestration-instructions.js"

const ALL_KNOWN_IDS = [...MODEL_CAPABILITIES.keys()]

function fakeMetadata(slug: string): ModelMetadata {
	return {
		slug,
		display_name: "",
		provider: "ai-enabler",
		reasoning: false,
		input_modalities: ["text"],
		is_serverless: true,
		limits: { context_window: 131072, max_output_tokens: 16384 },
	}
}

const ALL_KNOWN_METADATA = ALL_KNOWN_IDS.map(fakeMetadata)

describe("resolveOrchestrationInstructions", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("returns full instructions in orchestrator mode", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
		})
		expect(result).toContain("Orchestrate the work")
		expect(result).toContain("Sharing context between agents")
		expect(result).toContain("Agent delegation rules")
		expect(result).toContain("Model selection for delegation")
		expect(result).toContain("Token budgets")
		expect(result).toContain("token_budget")
	})

	it("includes model capabilities and available models in orchestrator mode", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
		})
		expect(result).toContain("## Your Capabilities")
		expect(result).toContain("## Available Models")
		for (const model of registry.getModelsWithCapabilities()) {
			if (model.id !== "kimi-k2.6") {
				expect(result).toContain(model.name)
			}
		}
	})

	it("returns empty string in single-model mode", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "single",
		})
		expect(result).toBe("")
	})

	it("returns subagent instructions in subagent mode", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "subagent",
		})
		expect(result).toContain("Subagent response protocol")
		expect(result).toContain('{"summary":')
		expect(result).not.toContain("Agent delegation rules")
	})

	it("includes model-specific orchestration guidelines when provided", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "minimax-m2.7",
			registry,
			mode: "orchestrator",
		})
		expect(result).toContain("### Orchestration Guidelines")
		expect(result).toContain("MiniMax M2 family")
	})
})
