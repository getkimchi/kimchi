import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../index.js"
import { buildOrchestrationGuidelinesSection, resolveOrchestrationGuideline } from "./guidelines-resolver.js"

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

describe("orchestration guideline resolution", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("returns empty string when no model is specified", () => {
		const result = resolveOrchestrationGuideline(undefined, registry)
		expect(result).toBe("")
	})

	it("returns composed orchestration guideline for minimax-m2.7", () => {
		const result = resolveOrchestrationGuideline("minimax-m2.7", registry)
		expect(result).toContain("MiniMax M2 family")
		expect(result).toContain("web_search")
		expect(result).toContain("front-load")
	})

	it("returns composed orchestration guideline for minimax-m3", () => {
		const result = resolveOrchestrationGuideline("minimax-m3", registry)
		expect(result).toContain("MiniMax M2 family")
		expect(result).toContain("web_search")
		expect(result).toContain("front-load")
	})

	it("returns composed orchestration guideline for kimi-k2.6", () => {
		const result = resolveOrchestrationGuideline("kimi-k2.6", registry)
		expect(result).toContain("Kimi family")
		expect(result).toContain("delegation sequence")
		expect(result).toContain("kimi-k2.6 specific")
		expect(result).toContain("chunk")
	})

	it("returns empty string for ignored model kimi-k2.5", () => {
		const result = resolveOrchestrationGuideline("kimi-k2.5", registry)
		expect(result).toBe("")
	})

	it("returns empty string for ignored model claude-opus-4-6", () => {
		const result = resolveOrchestrationGuideline("claude-opus-4-6", registry)
		expect(result).toBe("")
	})

	it("returns composed orchestration guideline for nemotron-3-ultra-fp4", () => {
		const result = resolveOrchestrationGuideline("nemotron-3-ultra-fp4", registry)
		expect(result).toContain("Nemotron family")
		expect(result).toContain("long context window")
	})

	it("returns empty string for unknown model IDs", () => {
		const result = resolveOrchestrationGuideline("nonexistent-model", registry)
		expect(result).toBe("")
	})
})

describe("orchestration guideline section building", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("builds orchestration guidelines section with content", () => {
		const result = buildOrchestrationGuidelinesSection("minimax-m3", registry)
		expect(result).toContain("### Orchestration Guidelines")
		expect(result).toContain("MiniMax M2 family")
	})

	it("returns empty string when no guidelines", () => {
		const result = buildOrchestrationGuidelinesSection(undefined, registry)
		expect(result).toBe("")
	})
})
