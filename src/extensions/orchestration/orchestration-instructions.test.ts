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
	const { teamSection, instructionsSection } = resolveOrchestrationInstructions(ctx)
	return [teamSection, instructionsSection].filter(Boolean).join("\n\n")
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
		expect(result).toContain("Orchestrate the work")
	})

	it("shows role assignments with Your Team section", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("## Your Team")
		expect(result).toContain("### Builder")
		expect(result).toContain("### Reviewer")
		expect(result).toContain("### Explorer")
	})

	it("shows Your Capabilities section with orchestrator roles", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.7",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("## Your Capabilities")
		expect(result).toContain("You have these roles: **planner, reviewer**")
	})

	it("uses DO/DONT directives in Step 3", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Your responsibilities per phase")
		expect(result).toContain("#### Plan phase")
		expect(result).toContain("#### Build phase")
		expect(result).toContain("#### Review phase")
		expect(result).toContain("#### Explore phase")
		expect(result).toContain("#### Research phase")
	})

	it("exempts Explore from markdown artifact handoff rules", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})

		expect(result).toContain("Explore findings are not durable artifacts")
		expect(result).toContain("Explore agents return decision-ready findings directly in the Agent result")
		expect(result).toContain(
			"Do NOT ask Explore agents to write Markdown files, reports, docs, notes, or scratch files",
		)
		expect(result).toContain(
			"For artifact-producing agents (Plan, Reviewer, Fixer, and Researcher when the research is non-trivial)",
		)
		expect(result).not.toContain("Pass plans and structured findings as Markdown files")
	})

	it("instructs to use matching persona for each step", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: {
				...DEFAULT_MODEL_ROLES,
				planner: "some-other/model",
			},
		})
		expect(result).toContain('Agent(type: "Plan"')
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

	it("generates DO directive for plan when orchestrator is planner", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.7",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("### Planner")
		expect(result).toContain("DO write the plan yourself")
		expect(result).not.toContain("DO NOT write the plan yourself")
	})

	it("generates DO NOT directive for plan when orchestrator is not planner", () => {
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
		expect(result).toContain("DO NOT write the plan yourself")
		expect(result).toContain('delegate planning to Agent(type: "Plan"')
		expect(result).not.toContain("DO write the plan yourself")
	})

	it("renders tier and description for models in Your Team", () => {
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
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("race/thread-safety detector")
		expect(result).toContain("go test -race")
	})

	it("includes chunk complexity classification in plan and build phases", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("complexity")
		expect(result).toContain("`simple`")
		expect(result).toContain("`complex`")
		expect(result).toContain("Complex chunks get the multi-file-package token budget")
	})

	it("includes complex chunk spec detail requirements", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("What makes a good complex chunk spec")
		expect(result).toContain("concurrency/algorithm primitives")
		expect(result).toContain("lifecycle of goroutines/threads")
		expect(result).toContain("error propagation path")
	})

	it("includes review row in budget table", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("Review (read code + write findings report)")
		expect(result).toContain("Heavy-tier model duration scaling")
	})

	it("does not include lightweight re-verification guidance", () => {
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).not.toContain("Prefer lightweight re-verification")
	})

	it("includes model-specific orchestration guidelines when provided", () => {
		const result = resolveAsString({
			currentModelId: "minimax-m3",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("### Orchestration Guidelines")
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
})

describe("resolveOrchestrationInstructions with custom configs", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("shows external model with custom config in Your Team with tier and description", () => {
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

	it("shows external orchestrator model with custom config in Your Capabilities using assigned roles", () => {
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
		expect(result).toContain("External orchestrator model.")
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
		// Regression: prompt-enrichment.ts passes `getOrchestratorModelId()` (bare
		// model id) as `currentModelId`, but `modelMetadata` in settings.json is
		// keyed by full ref (`anthropic/claude-opus-4-6`). `resolveModelMeta` did
		// `customConfigs?.get(ref)` directly, so the orchestrator's own custom
		// tier/description/vision was silently dropped from "Your Capabilities".
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

describe("Build phase directive (complex-chunk tier routing)", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("routes complex chunks to a heavy-tier Builder on first attempt, not as a retry", () => {
		// Regression: the previous directive said "Use a standard-tier Builder by default.
		// Use a heavy-tier Builder only as a retry when a standard-tier Builder has
		// already failed." That contradicts the tier model elsewhere in the prompt,
		// which says complex chunks (concurrency, state machines, algorithms) require
		// a heavy-tier Builder. The new tier metadata would never actually route
		// complex chunks to the heavy model on the first attempt.
		const result = resolveAsString({
			currentModelId: "kimi-k2.6",
			registry,
			roles: DEFAULT_MODEL_ROLES,
		})
		expect(result).toContain("#### Build phase")
		// The directive must explicitly call out heavy-tier for complex chunks on the first attempt.
		expect(result).toMatch(/complex chunk.*heavy-tier Builder/s)
		// And it must NOT tell the orchestrator to start with standard-tier and only escalate on retry.
		expect(result).not.toMatch(/standard-tier Builder by default.*retry/s)
	})
})
