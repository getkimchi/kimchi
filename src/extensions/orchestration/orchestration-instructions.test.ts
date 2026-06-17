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

	it("shows role assignments with Your Team section", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("## Your Team")
		expect(result).toContain("### Builder")
		expect(result).toContain("### Reviewer")
		expect(result).toContain("### Explorer")
	})

	it("shows Your Capabilities section with orchestrator roles", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("## Your Capabilities")
		expect(result).toContain("Roles: research, plan, build, review")
	})

	it("uses role-based delegation rules in Step 3", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Your roles are the authoritative signal")
		expect(result).toContain("If a step matches your roles")
		expect(result).toContain("delegate it to a model from the matching role pool")
	})

	it("instructs to use matching persona for each step", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain('Agent(type: "Builder"')
		expect(result).toContain('Agent(type: "Reviewer"')
		expect(result).toContain('Agent(type: "Fixer"')
		expect(result).toContain('Agent(type: "Explore"')
		expect(result).toContain('Agent(type: "Plan"')
	})

	it("shows model IDs from the roles config", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: {
				orchestrator: "anthropic/claude-opus-4-7",
				planner: "anthropic/claude-opus-4-7",
				builder: "anthropic/claude-sonnet-4-5",
				reviewer: "openai/gpt-4o",
				explorer: "kimchi-dev/nemotron-3-ultra-fp4",
				judge: "kimchi-dev/claude-opus-4-6",
			},
		})
		expect(result).toContain("anthropic/claude-sonnet-4-5")
		expect(result).toContain("openai/gpt-4o")
		expect(result).toContain("kimchi-dev/nemotron-3-ultra-fp4")
	})

	it("omits Planner section when planner equals orchestrator", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("### Planner")
		expect(result).toContain("you write the plan yourself in-process")
	})

	it("shows Planner section when planner has multiple models or differs from orchestrator", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: {
				...DEFAULT_MODEL_ROLES,
				planner: "anthropic/claude-opus-4-7",
			},
		})
		expect(result).toContain("### Planner")
		expect(result).toContain("anthropic/claude-opus-4-7")
	})

	it("renders tier and description for models in Your Team", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Tier: standard")
		expect(result).toContain("Tier: heavy")
		expect(result).toContain("Tier: light")
	})

	it("still works without roles (no team section, instructions only)", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
		})
		expect(result).toContain("Sharing context between agents")
		expect(result).toContain("Orchestrate the work")
		expect(result).toContain("Token budgets")
		expect(result).toContain("token_budget")
		expect(result).toContain("Plan self-validation")
		expect(result).toContain("Plan verification")
		expect(result).toContain("What makes a good plan")
		expect(result).toContain("Skip verification when")
		expect(result).toContain("Require verification when")
		expect(result).not.toContain("## Your Team")
	})

	it("includes concurrency test mandate in plan checklist", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("race/thread-safety detector")
		expect(result).toContain("go test -race")
	})

	it("includes chunk complexity classification in plan and build phases", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("complexity")
		expect(result).toContain("`simple`")
		expect(result).toContain("`complex`")
		expect(result).toContain("Complex chunks get the multi-file-package token budget")
	})

	it("includes complex chunk spec detail requirements", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("What makes a good complex chunk spec")
		expect(result).toContain("concurrency/algorithm primitives")
		expect(result).toContain("lifecycle of goroutines/threads")
		expect(result).toContain("error propagation path")
	})

	it("includes review row in budget table", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Review (read code + write findings report)")
		expect(result).toContain("Heavy-tier model duration scaling")
	})

	it("does not include lightweight re-verification guidance", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("Prefer lightweight re-verification")
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
		expect(result).not.toContain("Your Team")
	})

	it("does not affect single-model mode even with roles", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "single",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Single-Model Mode")
		expect(result).not.toContain("Your Team")
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

	it("renders multiple models per role when configured as array", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: {
				orchestrator: "kimchi-dev/kimi-k2.6",
				planner: "kimchi-dev/kimi-k2.6",
				builder: ["kimchi-dev/minimax-m2.7", "kimchi-dev/kimi-k2.6"],
				reviewer: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
				explorer: "kimchi-dev/nemotron-3-ultra-fp4",
				judge: "kimchi-dev/kimi-k2.6",
			},
		})
		expect(result).toContain("### Builder")
		expect(result).toContain("minimax-m2.7")
		expect(result).toContain("### Reviewer")
	})
})
