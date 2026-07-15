import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../models.js"
import type { ModelCustomMetadata } from "./model-metadata.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "./model-registry/index.js"
import { DEFAULT_MODEL_ROLES } from "./model-roles.js"
import {
	type OrchestrationInstructionsContext,
	resolveOrchestrationInstructions,
} from "./orchestration-instructions.js"

function resolveAsString(ctx: OrchestrationInstructionsContext): string {
	const { instructionsSection } = resolveOrchestrationInstructions(ctx)
	return instructionsSection
}

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
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("## Orchestration")
	})

	it("shows role assignments with Your team subsection", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("### Your team")
		expect(result).toContain("### Builder")
		expect(result).toContain("### Reviewer")
		expect(result).toContain("### Explorer")
	})

	it("shows Your roles subsection with orchestrator roles", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.7",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("### Your roles")
		expect(result).toContain("You have these roles")
	})

	it("includes delegation guidance", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("### Delegation")
		expect(result).toContain("You cannot read files, write code")
		expect(result).toContain("everything goes through sub-agents")
		expect(result).toContain("Do not blindly retry the same approach")
	})

	it("exempts Explore from markdown artifact handoff rules", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})

		expect(result).toContain("Explore agents return decision-ready findings directly in the Agent result")
		expect(result).toContain("must not be asked to write Markdown files, reports, docs, notes, or scratch files")
		expect(result).toContain(
			"For artifact-producing agents (Plan, Reviewer, Fixer, and Researcher when the research is non-trivial)",
		)
		expect(result).toContain("one decision-relevant question to answer")
		expect(result).toContain("Return decision-ready findings to the parent; do not write files.")
	})

	it("instructs to use matching model for each role", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: {
				...DEFAULT_MODEL_ROLES,
				planner: "some-other/model",
			},
		})
		expect(result).toContain("some-other/model")
	})

	it("shows model IDs from the roles config", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: {
				orchestrator: "anthropic/claude-opus-4-7",
				planner: "anthropic/claude-opus-4-7",
				builder: "anthropic/claude-sonnet-4-5",
				reviewer: "openai/gpt-4o",
				explorer: "kimchi-dev/nemotron-3-ultra-fp4",
				researcher: "kimchi-dev/nemotron-3-ultra-fp4",
				judge: "kimchi-dev/claude-opus-4-6",
			},
		})
		expect(result).toContain("anthropic/claude-sonnet-4-5")
		expect(result).toContain("openai/gpt-4o")
		expect(result).toContain("kimchi-dev/nemotron-3-ultra-fp4")
	})

	it("does not show Planner section when orchestrator is planner", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.7",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("### Planner")
	})

	it("shows Planner section when orchestrator is not planner", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: {
				...DEFAULT_MODEL_ROLES,
				planner: "anthropic/claude-opus-4-7",
			},
		})
		expect(result).toContain("### Planner")
		expect(result).toContain("anthropic/claude-opus-4-7")
	})

	it("renders tier and description for models in Your team", () => {
		const result = resolveAsString({
			currentModelId: "minimax-m3",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Tier: heavy")
		expect(result).toContain("Tier: light")
	})

	it("still works without roles (no team section, instructions only)", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
		})
		expect(result).toContain("## Orchestration")
		expect(result).toContain("Token budgets")
		expect(result).toContain("token_budget")
		expect(result).toContain("### Delegation")
		expect(result).not.toContain("### Your team")
		expect(result).not.toContain("### Your roles")
		// Should not contain old process prescription content
		expect(result).not.toContain("Classify the task")
		expect(result).not.toContain("Select pipeline steps")
		expect(result).not.toContain("Plan quality checklist")
		expect(result).not.toContain("Mandatory pipeline for complex tasks")
	})

	it("renders team roster with roles even when registry is absent", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("### Your team")
		expect(result).toContain("### Builder")
		expect(result).toContain("### Reviewer")
		expect(result).toContain("### Explorer")
		expect(result).toContain("Tier: standard")
	})

	it("does not include old plan quality checklist", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("Plan quality checklist")
		expect(result).not.toContain("race/thread-safety detector")
		expect(result).not.toContain("Anti-flaky rule")
	})

	it("does not include old plan verification protocol", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("Plan verification")
		expect(result).not.toContain("Skip verification when")
		expect(result).not.toContain("Require verification when")
	})

	it("does not include old review phase contract", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("Review output contract")
		expect(result).not.toContain("Review phase turn budget")
		expect(result).not.toContain("NEEDS_FIXES")
		expect(result).not.toContain("Fix agent contract")
	})

	it("does not include old pipeline steps", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("Classify the task")
		expect(result).not.toContain("Select pipeline steps")
		expect(result).not.toContain("Intent boundary")
		expect(result).not.toContain("Mandatory pipeline")
		expect(result).not.toContain("Phase responsibilities")
		expect(result).not.toContain("#### Plan phase")
		expect(result).not.toContain("#### Build phase")
		expect(result).not.toContain("#### Review phase")
		expect(result).not.toContain("#### Explore phase")
		expect(result).not.toContain("#### Research phase")
	})

	it("includes thinking levels guidance and delegation table", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("### Thinking levels")
		expect(result).toContain("Always pass a `thinking` parameter on every Agent call")
		expect(result).toContain("| Build chunk | Builder |")
		expect(result).toContain("Orchestrator-provided `thinking` overrides agent profile defaults")
	})

	it("includes review row in budget table", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Review (read code + write findings)")
		expect(result).toContain("Heavy-tier model duration scaling")
	})

	it("discourages General-Purpose agents for specialized phases", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Use General-Purpose agents as a last resort only")
	})

	it("does not include lightweight re-verification guidance", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("Prefer lightweight re-verification")
	})

	it("includes model-specific orchestration notes when provided", () => {
		const result = resolveAsString({
			currentModelId: "minimax-m3",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("### Model-specific notes")
		expect(result).toContain("MiniMax M2 family")
	})

	it("renders multiple models per role when configured as array", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: {
				orchestrator: "kimchi-dev/kimi-k2.6",
				planner: "kimchi-dev/kimi-k2.6",
				builder: ["kimchi-dev/minimax-m2.7", "kimchi-dev/kimi-k2.6"],
				reviewer: ["kimchi-dev/kimi-k2.6", "kimchi-dev/minimax-m2.7"],
				explorer: "kimchi-dev/nemotron-3-ultra-fp4",
				researcher: "kimchi-dev/nemotron-3-ultra-fp4",
				judge: "kimchi-dev/kimi-k2.6",
			},
		})
		expect(result).toContain("### Builder")
		expect(result).toContain("minimax-m2.7")
		expect(result).toContain("### Reviewer")
	})

	it("includes model selection section with role-to-model mapping", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("### Model selection")
		expect(result).toContain("**Builder** (code implementation)")
		expect(result).toContain("**Reviewer** (code review, verification)")
		expect(result).toContain("**Explorer** (codebase exploration)")
		expect(result).toContain("**Planner** (design, specs)")
	})
})

describe("resolveOrchestrationInstructions with custom configs", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("shows external model with custom config in Your team with tier and description", () => {
		const customConfigs = new Map<string, ModelCustomMetadata>([
			[
				"anthropic/external-model",
				{ tier: "heavy", description: "Anthropic's flagship external model.", vision: false },
			],
		])
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: {
				orchestrator: "kimchi-dev/kimi-k2.6",
				planner: "kimchi-dev/kimi-k2.6",
				builder: "anthropic/external-model",
				reviewer: "kimchi-dev/minimax-m2.7",
				explorer: "kimchi-dev/nemotron-3-super-fp4",
				researcher: "kimchi-dev/nemotron-3-super-fp4",
				judge: "kimchi-dev/kimi-k2.6",
			},
			customConfigs,
		})
		expect(result).toContain("anthropic/external-model")
		expect(result).toContain("Tier: heavy")
		expect(result).toContain("Anthropic's flagship external model.")
	})

	it("shows external orchestrator model with custom config in Your roles using assigned roles", () => {
		const customConfigs = new Map<string, ModelCustomMetadata>([
			["external-orchestrator", { tier: "heavy", description: "External orchestrator model.", vision: true }],
		])
		const result = resolveAsString({
			currentModelId: "external-orchestrator",
			registry,
			roles: {
				orchestrator: "external-orchestrator",
				planner: "external-orchestrator",
				builder: "kimchi-dev/minimax-m2.7",
				reviewer: "kimchi-dev/minimax-m2.7",
				explorer: "kimchi-dev/nemotron-3-super-fp4",
				researcher: "kimchi-dev/nemotron-3-super-fp4",
				judge: "external-orchestrator",
			},
			customConfigs,
		})
		expect(result).toContain("Tier: heavy")
		expect(result).toContain("You have these roles: **planner**")
		expect(result).toContain("Vision: yes")
		expect(result).toContain("Extended thinking:")
	})

	it("external model without custom config defaults to standard tier and vision no", () => {
		const roles = {
			orchestrator: "kimchi-dev/kimi-k2.6",
			planner: "kimchi-dev/kimi-k2.6",
			builder: "unknown-model",
			reviewer: "kimchi-dev/minimax-m2.7",
			explorer: "kimchi-dev/nemotron-3-super-fp4",
			researcher: "kimchi-dev/nemotron-3-super-fp4",
			judge: "kimchi-dev/kimi-k2.6",
		}
		const result = resolveAsString({
			currentModelId: "unknown-model",
			registry,
			roles,
		})
		expect(result).toContain("unknown-model")
		expect(result).toContain("Tier: standard")
		expect(result).toContain("Vision: no")
		expect(result).toContain("Extended thinking: no")
		expect(result).toContain("This model was configured by the user to handle builder work.")
		expect(result).not.toContain("Tier: undefined")
	})

	it("empty custom metadata defaults tier to standard and vision to no", () => {
		const customConfigs = new Map<string, ModelCustomMetadata>([["bare-external/model", {}]])
		const roles = {
			orchestrator: "kimchi-dev/kimi-k2.6",
			planner: "kimchi-dev/kimi-k2.6",
			builder: "bare-external/model",
			reviewer: "kimchi-dev/minimax-m2.7",
			explorer: "kimchi-dev/nemotron-3-super-fp4",
			researcher: "kimchi-dev/nemotron-3-super-fp4",
			judge: "kimchi-dev/kimi-k2.6",
		}
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles,
			customConfigs,
		})
		expect(result).toContain("bare-external/model")
		expect(result).toContain("Tier: standard")
		expect(result).toContain("Vision: no")
		expect(result).toContain("Extended thinking: no")
		expect(result).toContain("This model was configured by the user to handle builder work.")
		expect(result).not.toContain("Tier: undefined")
		expect(result).not.toContain("Vision: undefined")
	})

	it("external orchestrator without custom config shows roles from config", () => {
		const roles = {
			orchestrator: "external-orchestrator",
			planner: "external-orchestrator",
			builder: "kimchi-dev/minimax-m2.7",
			reviewer: "kimchi-dev/minimax-m2.7",
			explorer: "kimchi-dev/nemotron-3-super-fp4",
			researcher: "kimchi-dev/nemotron-3-super-fp4",
			judge: "external-orchestrator",
		}
		const result = resolveAsString({
			currentModelId: "external-orchestrator",
			registry,
			roles,
		})
		expect(result).toContain("Tier: standard")
		expect(result).toContain("You have these roles: **planner**")
		expect(result).toContain("Vision: no")
	})

	it("orchestrator custom metadata is not dropped when currentModelId is a bare model id (no provider)", () => {
		const customConfigs = new Map<string, ModelCustomMetadata>([
			[
				"anthropic/claude-opus-4-6",
				{ tier: "heavy", description: "Anthropic's flagship reasoning model.", vision: true },
			],
		])
		const roles = {
			orchestrator: "anthropic/claude-opus-4-6",
			planner: "anthropic/claude-opus-4-6",
			builder: "kimchi-dev/minimax-m2.7",
			reviewer: "kimchi-dev/minimax-m2.7",
			explorer: "kimchi-dev/nemotron-3-super-fp4",
			researcher: "kimchi-dev/nemotron-3-super-fp4",
			judge: "kimchi-dev/kimi-k2.6",
		}
		const result = resolveAsString({
			currentModelId: "claude-opus-4-6",
			registry,
			roles,
			customConfigs,
		})
		expect(result).toContain("Tier: heavy")
		expect(result).toContain("Vision: yes")
		expect(result).toContain("Anthropic's flagship reasoning model.")
	})

	it("model assigned to multiple roles lists all roles in default description", () => {
		const customConfigs = new Map<string, ModelCustomMetadata>([["multi-role/model", {}]])
		const roles = {
			orchestrator: "kimchi-dev/kimi-k2.6",
			planner: "kimchi-dev/kimi-k2.6",
			builder: "multi-role/model",
			reviewer: "multi-role/model",
			explorer: "kimchi-dev/nemotron-3-super-fp4",
			researcher: "kimchi-dev/nemotron-3-super-fp4",
			judge: "kimchi-dev/kimi-k2.6",
		}
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles,
			customConfigs,
		})
		expect(result).toContain("This model was configured by the user to handle builder, reviewer work.")
	})
})

describe("Model selection directives", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("includes role-to-model mapping dynamically from config", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: {
				orchestrator: "some-prov/model-a",
				planner: "some-prov/model-a",
				builder: "some-prov/model-b",
				reviewer: "some-prov/model-c",
				explorer: "some-prov/model-d",
				researcher: "some-prov/model-d",
				judge: "some-prov/model-a",
			},
		})
		expect(result).toContain("model-b")
		expect(result).toContain("model-c")
		expect(result).toContain("model-d")
	})
})
