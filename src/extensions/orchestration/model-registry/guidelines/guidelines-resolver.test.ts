import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../index.js"
import {
	buildModelGuidelinesSection,
	buildOrchestrationGuidelinesSection,
	resolveModelGuideline,
	resolveOrchestrationGuideline,
} from "./guidelines-resolver.js"

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

describe("model guideline resolution", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("returns empty string when no model is specified", () => {
		const result = resolveModelGuideline("build", undefined, registry)
		expect(result).toBe("")
	})

	it("returns model-specific guideline when model has one", () => {
		const result = resolveModelGuideline("build", "minimax-m2.7", registry)
		expect(result).toContain("MiniMax M2 family")
		expect(result).toContain("Outline-then-diff")
		expect(result).toContain("minimax-m2.7 specific")
		expect(result).toContain("mutex-based concurrency")
	})

	it("returns empty string for phases with no model override", () => {
		const result = resolveModelGuideline("explore", "minimax-m2.7", registry)
		expect(result).toBe("")
	})

	it("returns empty string for unknown model IDs", () => {
		const result = resolveModelGuideline("plan", "nonexistent-model", registry)
		expect(result).toBe("")
	})

	it("composes family and per-model layers for kimi-k2.6 plan", () => {
		const result = resolveModelGuideline("plan", "kimi-k2.6", registry)
		expect(result).toContain("Kimi family")
		expect(result).toContain("Chunks")
		expect(result).toContain("kimi-k2.6 specific")
		expect(result).toContain("per-chunk acceptance criteria")
	})
})

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

	it("returns composed orchestration guideline for nemotron-3-super-fp4", () => {
		const result = resolveOrchestrationGuideline("nemotron-3-super-fp4", registry)
		expect(result).toContain("Nemotron family")
		expect(result).toContain("long context window")
	})

	it("returns empty string for unknown model IDs", () => {
		const result = resolveOrchestrationGuideline("nonexistent-model", registry)
		expect(result).toBe("")
	})
})

describe("guideline section building", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("builds orchestration guidelines section with content", () => {
		const result = buildOrchestrationGuidelinesSection("minimax-m2.7", registry)
		expect(result).toContain("### Orchestration Guidelines")
		expect(result).toContain("MiniMax M2 family")
	})

	it("returns empty string when no guidelines", () => {
		const result = buildOrchestrationGuidelinesSection(undefined, registry)
		expect(result).toBe("")
	})

	it("builds model guidelines section with content", () => {
		const result = buildModelGuidelinesSection("minimax-m2.7", "build", registry)
		expect(result).toContain("## Model Guidelines")
		expect(result).toContain("Outline-then-diff")
	})

	it("returns empty string when no phase", () => {
		const result = buildModelGuidelinesSection("minimax-m2.7", undefined, registry)
		expect(result).toBe("")
	})

	it("returns empty string when model has no guideline for that phase", () => {
		const result = buildModelGuidelinesSection("minimax-m2.7", "explore", registry)
		expect(result).toBe("")
	})

	it("returns empty string for unknown model", () => {
		const result = buildModelGuidelinesSection("nonexistent-model", "build", registry)
		expect(result).toBe("")
	})
})

describe("builtin-model guideline content", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("kimi-k2.5 build: returns empty (ignored model)", () => {
		const result = resolveModelGuideline("build", "kimi-k2.5", registry)
		expect(result).toBe("")
	})

	it("kimi-k2.5 explore: returns empty (ignored model)", () => {
		const result = resolveModelGuideline("explore", "kimi-k2.5", registry)
		expect(result).toBe("")
	})

	it("kimi-k2.6 plan: contains family and per-model layers", () => {
		const result = resolveModelGuideline("plan", "kimi-k2.6", registry)
		expect(result).toContain("Chunks")
		expect(result).toContain("per-chunk acceptance criteria")
	})

	it("minimax-m2.7 build: contains family and per-model layers", () => {
		const result = resolveModelGuideline("build", "minimax-m2.7", registry)
		expect(result).toContain("Outline-then-diff")
		expect(result).toContain("mutex")
	})

	it("minimax-m2.7 review: contains family and per-model layers", () => {
		const result = resolveModelGuideline("review", "minimax-m2.7", registry)
		expect(result).toContain("scope creep")
		expect(result).toContain("hallucinated APIs")
		expect(result).toContain("inappropriate concurrency")
	})

	it("nemotron-3-super-fp4 explore: contains per-model layer", () => {
		const result = resolveModelGuideline("explore", "nemotron-3-super-fp4", registry)
		expect(result).toContain("1M token context window")
	})

	it("claude-opus-4-6 plan: returns empty (ignored model)", () => {
		const result = resolveModelGuideline("plan", "claude-opus-4-6", registry)
		expect(result).toBe("")
	})

	it("claude-opus-4-6 explore: returns empty (ignored model)", () => {
		const result = resolveModelGuideline("explore", "claude-opus-4-6", registry)
		expect(result).toBe("")
	})
})
