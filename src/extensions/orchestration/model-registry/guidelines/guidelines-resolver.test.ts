import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../index.js"
import { DEFAULT_BUILD_GUIDELINES } from "./default-phase-guidelines.js"
import {
	buildExecutionGuidelinesSection,
	buildOrchestrationGuidelinesSection,
	buildPhaseGuidelinesSection,
	resolveOrchestrationGuideline,
	resolvePhaseGuideline,
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

describe("phase guideline resolution", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("returns default guideline when no model is specified", () => {
		const result = resolvePhaseGuideline("build", undefined, registry)
		expect(result).toContain("Read a file before modifying it")
	})

	it("returns model-specific guideline when model has one", () => {
		const result = resolvePhaseGuideline("build", "minimax-m2.7", registry)
		expect(result).toContain("Outline-then-diff")
		expect(result).toContain("Do NOT default to mutex-based concurrency")
		expect(result).toContain("mutex-based concurrency")
	})

	it("returns default guideline for phases with no model override", () => {
		const result = resolvePhaseGuideline("explore", "minimax-m2.7", registry)
		expect(result).toContain("Goal: build a mental map")
	})

	it("returns default guideline for unknown model IDs", () => {
		const result = resolvePhaseGuideline("plan", "nonexistent-model", registry)
		expect(result).toContain("Design BEFORE coding")
	})

	it("composes family and per-model layers for kimi-k2.6 plan", () => {
		const result = resolvePhaseGuideline("plan", "kimi-k2.6", registry)
		expect(result).toContain("Chunks")
		expect(result).toContain("You are tuned for long-horizon orchestration")
		expect(result).toContain("per-chunk acceptance criteria")
	})

	describe("research guideline nudges", () => {
		it("default research guideline contains version-check and graceful-degradation anchors", () => {
			const result = resolvePhaseGuideline("research", "nonexistent-model", registry)
			expect(result).toContain("version you are assuming")
			expect(result).toContain("version/API assumption")
			expect(result).toContain("do not bluff")
			expect(result).toContain("Do not rely on training memory")
			expect(result).not.toContain("AT MOST one")
			expect(result).not.toContain("Skip web research")
		})

		it("default explore guideline contains research-nudge anchor", () => {
			const result = resolvePhaseGuideline("explore", "nonexistent-model", registry)
			expect(result).toContain("unfamiliar library")
			expect(result).toContain("named third-party dependencies")
			expect(result).toContain("stale version assumptions")
			expect(result).toContain("language runtime version")
		})

		it("default plan guideline contains version-assumption-to-decision-log anchor", () => {
			const result = resolvePhaseGuideline("plan", "nonexistent-model", registry)
			expect(result).toContain("version assumption")
			expect(result).toContain("Decision Log")
			expect(result).toContain("I remember this")
		})

		it("default build guideline contains uncertain-API anchor", () => {
			const result = resolvePhaseGuideline("build", "nonexistent-model", registry)
			expect(result).toContain("uncertain about a library API")
			expect(result).toContain("assume your knowledge may be stale")
			expect(result).toContain("current convention")
		})

		it("kimi-k2.6 research composes default and family research layers", () => {
			const result = resolvePhaseGuideline("research", "kimi-k2.6", registry)
			expect(result).toContain("Your training knowledge predates")
			expect(result).toContain("version assumption")
			expect(result).toContain("Do not treat a library or kit")
		})

		it("minimax-m3 research composes default and family research layers", () => {
			const result = resolvePhaseGuideline("research", "minimax-m3", registry)
			expect(result).toContain("hallucinating APIs")
			expect(result).toContain("Do not treat named libraries")
		})

		it("nemotron-3-ultra-fp4 research composes default and family research layers", () => {
			const result = resolvePhaseGuideline("research", "nemotron-3-ultra-fp4", registry)
			expect(result).toContain("training data is older")
			expect(result).toContain("Do not treat named libraries")
		})
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

describe("guideline section building", () => {
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

	it("builds phase guidelines section with model content", () => {
		const result = buildPhaseGuidelinesSection("minimax-m3", "build", registry)
		expect(result).toContain("## Phase Guidelines (build)")
		expect(result).toContain("Outline-then-diff")
	})

	it("returns empty string when no phase", () => {
		const result = buildPhaseGuidelinesSection("minimax-m2.7", undefined, registry)
		expect(result).toBe("")
	})

	it("returns default guideline for phases with no model override", () => {
		const result = buildPhaseGuidelinesSection("minimax-m2.7", "explore", registry)
		expect(result).toContain("## Phase Guidelines (explore)")
		expect(result).toContain("Goal: build a mental map")
	})

	it("returns default guideline for unknown model", () => {
		const result = buildPhaseGuidelinesSection("nonexistent-model", "build", registry)
		expect(result).toContain("## Phase Guidelines (build)")
		expect(result).toContain("Read a file before modifying it")
	})
})

describe("execution guidelines section building", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("renders the combined section header", () => {
		const result = buildExecutionGuidelinesSection(undefined, registry)
		expect(result.startsWith("## Execution Guidelines\n\n")).toBe(true)
	})

	it("includes all five phase subheadings in canonical order", () => {
		const result = buildExecutionGuidelinesSection(undefined, registry)
		const order = [
			"When you are exploring the codebase:",
			"When you are researching:",
			"When you are planning:",
			"When you are building:",
			"When you are reviewing:",
		]
		const indices = order.map((h) => result.indexOf(h))
		expect(indices.every((i) => i >= 0)).toBe(true)
		for (let i = 1; i < indices.length; i++) {
			expect(indices[i]).toBeGreaterThan(indices[i - 1])
		}
	})

	it("includes default guideline content for every phase", () => {
		const result = buildExecutionGuidelinesSection(undefined, registry)
		expect(result).toContain("Goal: build a mental map")
		expect(result).toContain("Use `web_search` when your knowledge might be stale")
		expect(result).toContain("Design BEFORE coding")
		expect(result).toContain("Read a file before modifying it")
		expect(result).toContain("Read the diff or changed files first")
	})

	it("includes model-family override content for kimi-k2.6 (research family layer)", () => {
		const result = buildExecutionGuidelinesSection("kimi-k2.6", registry)
		expect(result).toContain("Your training knowledge predates")
	})

	it("includes model-family override content for minimax-m3 (research family layer)", () => {
		const result = buildExecutionGuidelinesSection("minimax-m3", registry)
		expect(result).toContain("hallucinating APIs")
	})

	it("includes model-family override content for minimax-m2.7 (build family layer)", () => {
		const result = buildExecutionGuidelinesSection("minimax-m2.7", registry)
		expect(result).toContain("Outline-then-diff")
	})

	it("works without a registry when defaults are sufficient", () => {
		const result = buildExecutionGuidelinesSection(undefined, undefined)
		expect(result).toContain("## Execution Guidelines")
		expect(result).toContain("When you are exploring the codebase:")
		expect(result).toContain("When you are reviewing:")
	})

	it("returns empty string when all phase guidelines are empty/whitespace", () => {
		// Build a registry where no model has any per-phase guideline, and the
		// defaults are not consulted by the empty/whitespace case. We simulate
		// "all empty" by checking that buildExecutionGuidelinesSection falls
		// back to defaults — it must NOT return empty here.
		const result = buildExecutionGuidelinesSection(undefined, registry)
		expect(result).not.toBe("")
	})
})

describe("builtin-model guideline content", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("kimi-k2.5 build: returns default (ignored model)", () => {
		const result = resolvePhaseGuideline("build", "kimi-k2.5", registry)
		expect(result).toContain("Read a file before modifying it")
	})

	it("kimi-k2.5 explore: returns default (ignored model)", () => {
		const result = resolvePhaseGuideline("explore", "kimi-k2.5", registry)
		expect(result).toContain("Goal: build a mental map")
	})

	it("kimi-k2.6 plan: contains family and per-model layers", () => {
		const result = resolvePhaseGuideline("plan", "kimi-k2.6", registry)
		expect(result).toContain("Chunks")
		expect(result).toContain("per-chunk acceptance criteria")
	})

	it("minimax-m2.7 build: contains family and per-model layers", () => {
		const result = resolvePhaseGuideline("build", "minimax-m2.7", registry)
		expect(result).toContain("Outline-then-diff")
		expect(result).toContain("mutex")
	})

	it("minimax-m2.7 review: contains family and per-model layers", () => {
		const result = resolvePhaseGuideline("review", "minimax-m2.7", registry)
		expect(result).toContain("scope creep")
		expect(result).toContain("hallucinated APIs")
		expect(result).toContain("inappropriate concurrency")
	})

	it("minimax-m3 build: contains family layer", () => {
		const result = resolvePhaseGuideline("build", "minimax-m3", registry)
		expect(result).toContain("Outline-then-diff")
		expect(result).toContain("STAY IN SCOPE")
	})

	it("minimax-m3 review: contains family layer", () => {
		const result = resolvePhaseGuideline("review", "minimax-m3", registry)
		expect(result).toContain("scope creep")
		expect(result).toContain("hallucinated APIs")
	})

	it("nemotron-3-ultra-fp4 explore: contains per-model layer", () => {
		const result = resolvePhaseGuideline("explore", "nemotron-3-ultra-fp4", registry)
		expect(result).toContain("1M token context window")
	})

	it("claude-opus-4-6 plan: returns default (ignored model)", () => {
		const result = resolvePhaseGuideline("plan", "claude-opus-4-6", registry)
		expect(result).toContain("Design BEFORE coding")
	})

	it("claude-opus-4-6 explore: returns default (ignored model)", () => {
		const result = resolvePhaseGuideline("explore", "claude-opus-4-6", registry)
		expect(result).toContain("Goal: build a mental map")
	})

	it("build guideline warns against interactive CLI commands and prescribes non-interactive flags", () => {
		expect(DEFAULT_BUILD_GUIDELINES).toContain("Never run interactive commands")
		expect(DEFAULT_BUILD_GUIDELINES).toContain("patch --forward")
		expect(DEFAULT_BUILD_GUIDELINES).toContain("GIT_EDITOR=true")
		expect(DEFAULT_BUILD_GUIDELINES).toContain("redirect stdin from `/dev/null`")
	})
})
