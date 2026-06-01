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
		expect(result).toContain("Builder")
		expect(result).toContain("Reviewer")
		expect(result).toContain("Explorer")
	})

	it("uses role-based delegation rules", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("delegate to the **Builder** model")
		expect(result).toContain("delegate to the **Reviewer** model")
		expect(result).toContain("delegate to the **Explorer** model")
		expect(result).not.toContain("standard-tier model with `build` strength")
	})

	it("instructs to always use General-Purpose subagent type", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain('subagent_type: "General-Purpose"')
		expect(result).toContain("Do not use other subagent types")
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
				explorer: "kimchi-dev/nemotron-3-super-fp4",
				judge: "kimchi-dev/claude-opus-4-6",
			},
		})
		expect(result).toContain("anthropic/claude-sonnet-4-5")
		expect(result).toContain("openai/gpt-4o")
		expect(result).toContain("kimchi-dev/nemotron-3-super-fp4")
	})

	it("self-serves planning when planner equals orchestrator", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("always write the plan yourself")
		expect(result).not.toContain("delegate to the **Planner** model")
		expect(result).not.toContain("**Planner**:")
	})

	it("delegates planning when planner differs from orchestrator", () => {
		const result = resolveOrchestrationInstructions({
			currentModelId: "kimi-k2.6",
			registry,
			mode: "orchestrator",
			roles: {
				...DEFAULT_MODEL_ROLES,
				planner: "anthropic/claude-opus-4-7",
			},
		})
		expect(result).toContain("delegate to the **Planner** model")
		expect(result).not.toContain("always write the plan yourself")
		expect(result).toContain("**Planner**:")
		expect(result).toContain("anthropic/claude-opus-4-7")
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
})
