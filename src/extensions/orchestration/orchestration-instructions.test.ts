import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "./model-registry/index.js"
import { DEFAULT_MODEL_ROLES } from "./model-roles.js"
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

	it("returns orchestration instructions in orchestrator mode", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Orchestrate the work")
	})

	it("shows Available Models and Your Capabilities sections", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("## Available Models")
		expect(result).toContain("## Your Capabilities")
		expect(result).not.toContain("## Your Team")
	})

	it("uses strength-based delegation rules", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Your strengths are the authoritative signal")
		expect(result).toContain("If a step matches your strengths")
		expect(result).toContain("review must be cross-checked")
		expect(result).not.toContain("Always delegate — no exceptions")
	})

	it("includes model selection section with lightest-model guidance", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("### Model selection for delegation")
		expect(result).toContain("Use the lightest model with the required capability")
		expect(result).toContain("Prefer cheaper models for mechanical work")
	})

	it("includes the simple 4-row budget table", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("| Single file")
		expect(result).toContain("50000")
		expect(result).toContain("| Multi-file package")
		expect(result).toContain("150000")
	})

	it("populates model catalogue from roles config", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("minimax-m2.7")
		expect(result).toContain("nemotron-3-super-fp4")
	})

	it("shows Recommended for labels based on role assignments", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Recommended for: build")
		expect(result).toContain("Recommended for: explore, research")
	})

	it("shows tier and strengths for models in the catalogue", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toMatch(/Tier: (light|standard|heavy)/)
		expect(result).toMatch(/Strengths:/)
		expect(result).toMatch(/Vision: (yes|no)/)
	})

	it("excludes the orchestrator model from Available Models when it is not a subagent role", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: {
				...DEFAULT_MODEL_ROLES,
				reviewer: "kimchi-dev/kimi-k2.5",
			},
		})
		const modelsSection = result.split("## Your Capabilities")[0]
		expect(modelsSection).not.toMatch(/Recommended for:.*\bkimi-k2\.6\b/)
	})

	it("deduplicates models that fill multiple roles", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: {
				...DEFAULT_MODEL_ROLES,
				builder: "kimchi-dev/minimax-m2.7",
				reviewer: "kimchi-dev/minimax-m2.7",
			},
		})
		const matches = result.match(/minimax-m2\.7/g) ?? []
		const entryMatches = matches.filter((_, i) => i < 5)
		const modelsSection = result.split("## Your Capabilities")[0]
		const modelEntries = modelsSection.split("- **").length - 1
		expect(modelEntries).toBeGreaterThanOrEqual(1)
		expect(modelsSection).toContain("Recommended for: build, review")
	})

	it("shows custom model IDs from the roles config", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: {
				orchestrator: "anthropic/claude-opus-4-7",
				planner: "anthropic/claude-opus-4-7",
				builder: "anthropic/claude-sonnet-4-5",
				reviewer: "openai/gpt-4o",
				explorer: "kimchi-dev/nemotron-3-super-fp4",
			},
		})
		expect(result).toContain("anthropic/claude-sonnet-4-5")
		expect(result).toContain("openai/gpt-4o")
		expect(result).toContain("kimchi-dev/nemotron-3-super-fp4")
	})

	it("includes plan verification with standard-tier model and 15k budget", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Plan verification")
		expect(result).toContain("token_budget = 15,000")
		expect(result).toContain("max_turns = 5")
	})

	it("includes concurrency test mandate in review phase", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("race/thread-safety detector")
		expect(result).toContain("go test -race")
	})

	it("includes review findings file mandate", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("review_findings.md")
		expect(result).toContain("severity (MAJOR/MINOR)")
	})

	it("includes post-abort delegation rule", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Post-abort anti-pattern")
		expect(result).toContain("Spawn a follow-up Agent")
	})

	it("includes greenfield skip-explore clarification", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("reading skill files and reference documents")
		expect(result).toContain("plan phase instead")
	})

	it("includes simple research exception with budget discipline", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("simple research")
		expect(result).toContain("AT MOST one web_search call")
		expect(result).toContain("Do NOT follow up with web_fetch")
	})

	it("includes integration test mandate in plan checklist", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("integration/smoke test chunk")
		expect(result).toContain("httptest.NewServer")
	})

	it("still works without roles (falls back to full registry)", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
		})
		expect(result).toContain("## Available Models")
		expect(result).toContain("## Your Capabilities")
		expect(result).toContain("Orchestrate the work")
		expect(result).toContain("Token budgets")
		expect(result).toContain("What makes a good plan")
	})

	it("returns single-model instructions with model ID in single-model mode", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "single",
		})
		expect(result).toContain("Single-Model Mode")
		expect(result).toContain("kimi-k2.6")
		expect(result).toContain("MUST always pass your own model ID")
		expect(result).toContain("never delegate to a different model")
	})

	it("returns subagent instructions in subagent mode", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "subagent",
		})
		expect(result).toContain("Subagent response protocol")
		expect(result).toContain('{"summary":')
		expect(result).not.toContain("Orchestrate the work")
	})

	it("does not affect subagent mode even with roles", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "subagent",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Subagent response protocol")
		expect(result).not.toContain("Available Models")
	})

	it("does not affect single-model mode even with roles", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "single",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Single-Model Mode")
		expect(result).not.toContain("Available Models")
	})

	it("includes model-specific orchestration guidelines when provided", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "minimax-m2.7",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("### Orchestration Guidelines")
		expect(result).toContain("MiniMax M2 family")
	})

	it("does not contain removed concepts", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("Your Team")
		expect(result).not.toContain("Always delegate — no exceptions")
		expect(result).not.toContain("Hard rule")
		expect(result).not.toContain("PLAN_RULE_PLACEHOLDER")
		expect(result).not.toContain("complexity hint")
		expect(result).not.toContain("Re-review (verification-only)")
	})
})
