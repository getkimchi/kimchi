import type { Skill } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../model-registry/index.js"
import {
	type EnvironmentInfo,
	buildOrchestratorSystemPrompt,
	buildSingleModelSystemPrompt,
	buildSubagentSystemPrompt,
	resolveOrchestrationGuideline,
	resolvePhaseGuideline,
	transformPrompt,
} from "./prompt-transformer.js"

const testEnv: EnvironmentInfo = {
	os: "Linux",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/projects/myapp",
	documentsDir: "/home/testuser/projects/myapp/.kimchi/docs",
	currentTime: "2026-01-01T00:00:00.000Z",
	localDate: "2026-01-01",
	isGitRepo: false,
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

function createSkill(overrides: Partial<Skill> & { name: string; description: string }): Skill {
	return {
		filePath: `/skills/${overrides.name}/SKILL.md`,
		baseDir: `/skills/${overrides.name}`,
		sourceInfo: { path: `/skills/${overrides.name}/SKILL.md`, source: "local", scope: "project", origin: "top-level" },
		disableModelInvocation: false,
		...overrides,
	}
}

describe("transformPrompt", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)
	const currentModel = { id: "kimi-k2.5", name: "Kimi K2.5" }

	it("includes the original user prompt", () => {
		const result = transformPrompt("Fix the login bug", registry)
		expect(result).toContain("Fix the login bug")
	})

	it("includes model descriptions", () => {
		const result = transformPrompt("some task", registry)
		for (const model of registry.getAll()) {
			expect(result).toContain(model.capabilities.description)
		}
	})

	it("includes model strengths", () => {
		const result = transformPrompt("some task", registry)
		for (const model of registry.getAll()) {
			for (const strength of model.capabilities.strengths) {
				expect(result).toContain(strength)
			}
		}
	})

	it("includes vision info", () => {
		const result = transformPrompt("some task", registry)
		expect(result).toContain("Vision")
	})

	it("includes tier info for every model", () => {
		const result = transformPrompt("some task", registry)
		for (const model of registry.getAll()) {
			expect(result).toContain(`Tier: ${model.capabilities.tier}`)
		}
	})

	it("wraps content in structured sections", () => {
		const result = transformPrompt("do something", registry)
		expect(result).toContain("## Model Attributes")
		expect(result).toContain("## Available Models")
		expect(result).toContain("## Task")
	})

	it("excludes the current model from the subagent models list", () => {
		const result = transformPrompt("some task", registry, currentModel)
		// All models with capabilities except the current one should appear in the models section
		const otherModels = registry.getModelsWithCapabilities().filter((m) => m.id !== currentModel.id)
		for (const model of otherModels) {
			expect(result).toContain(model.name)
		}
		// Kimi's formatted model entry should not appear in the models section
		const modelsSection = result.split("## Available Models")[1].split("## Task")[0]
		expect(modelsSection).not.toContain("Kimi K2.5")
	})

	it("includes all models when no current model is provided", () => {
		const result = transformPrompt("some task", registry)
		for (const model of registry.getAll()) {
			expect(result).toContain(model.name)
		}
	})
})

describe("buildOrchestratorSystemPrompt", () => {
	const tools = [
		{ name: "read", description: "Read file contents" },
		{ name: "bash", description: "Execute bash commands" },
		{ name: "subagent", description: "Spawn an isolated subagent process" },
	]

	it("includes all tool names and descriptions", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv)
		for (const tool of tools) {
			expect(result).toContain(tool.name)
			expect(result).toContain(tool.description)
		}
	})

	it("formats tools as a list", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv)
		expect(result).toContain("- read: Read file contents")
		expect(result).toContain("- subagent: Spawn an isolated subagent process")
	})

	it("contains self-classification instructions", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv)
		expect(result).toContain("subagent")
		expect(result).toContain("delegate")
	})

	it("replaces the {{TOOLS}} placeholder", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv)
		expect(result).not.toContain("{{TOOLS}}")
	})

	it("handles empty tools list", () => {
		const result = buildOrchestratorSystemPrompt([], testEnv)
		expect(result).toContain("(No tools available)")
		expect(result).not.toContain("{{TOOLS}}")
	})

	it("replaces the {{PROJECT_CONTEXT}} placeholder when no context files", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv)
		expect(result).not.toContain("{{PROJECT_CONTEXT}}")
	})

	it("injects project context files into the prompt", () => {
		const contextFiles = [
			{ path: "/repo/AGENTS.md", content: "Always run tests before committing." },
			{ path: "/repo/sub/CLAUDE.md", content: "Use pnpm, not npm." },
		]
		const result = buildOrchestratorSystemPrompt(tools, testEnv, contextFiles)
		expect(result).toContain("# Project Guidelines")
		expect(result).toContain("Always run tests before committing.")
		expect(result).toContain("Use pnpm, not npm.")
		expect(result).not.toContain("/repo/AGENTS.md")
		expect(result).not.toContain("/repo/sub/CLAUDE.md")
		expect(result).not.toContain("{{PROJECT_CONTEXT}}")
	})

	it("places project guidelines after the guidelines section", () => {
		const contextFiles = [{ path: "/repo/AGENTS.md", content: "custom rule" }]
		const result = buildOrchestratorSystemPrompt(tools, testEnv, contextFiles)
		const guidelinesPos = result.indexOf("## Guidelines")
		const contextPos = result.indexOf("# Project Guidelines")
		expect(guidelinesPos).toBeLessThan(contextPos)
	})

	it("replaces the {{SKILLS}} placeholder when no skills", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv)
		expect(result).not.toContain("{{SKILLS}}")
	})

	it("injects skills into the prompt", () => {
		const skills = [
			createSkill({ name: "deploy", description: "Deploy the app to production" }),
			createSkill({ name: "review", description: "Review a pull request" }),
		]
		const result = buildOrchestratorSystemPrompt(tools, testEnv, undefined, skills)
		expect(result).toContain("available_skills")
		expect(result).toContain("deploy")
		expect(result).toContain("Deploy the app to production")
		expect(result).toContain("review")
		expect(result).toContain("Review a pull request")
	})

	it("excludes skills with disableModelInvocation", () => {
		const skills = [
			createSkill({ name: "safe-skill", description: "Visible skill" }),
			createSkill({ name: "hidden-skill", description: "Hidden skill", disableModelInvocation: true }),
		]
		const result = buildOrchestratorSystemPrompt(tools, testEnv, undefined, skills)
		expect(result).toContain("safe-skill")
		expect(result).not.toContain("hidden-skill")
	})

	it("injects environment info into the prompt", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv)
		expect(result).toContain("# Environment")
		expect(result).toContain(`OS: ${testEnv.os}`)
		expect(result).toContain(`Username: ${testEnv.username}`)
		expect(result).toContain(`Home directory: "${testEnv.homeDir}"`)
		expect(result).toContain(`Working directory: "${testEnv.cwd}"`)
		expect(result).toContain(`Current time: ${testEnv.currentTime} (local date: ${testEnv.localDate})`)
		expect(result).toContain("Git repository: no")
	})

	it("injects git branch and remote when present", () => {
		const gitEnv: EnvironmentInfo = {
			...testEnv,
			isGitRepo: true,
			gitBranch: "main",
			gitRemote: "git@github.com:org/repo.git",
		}
		const result = buildOrchestratorSystemPrompt(tools, gitEnv)
		expect(result).toContain("Git repository: yes")
		expect(result).toContain("Git branch: main")
		expect(result).toContain("Git remote: git@github.com:org/repo.git")
	})

	it("omits git branch and remote lines when not a git repo", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv)
		expect(result).not.toContain("Git branch:")
		expect(result).not.toContain("Git remote:")
	})

	it("replaces the {{ENVIRONMENT}} placeholder", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv)
		expect(result).not.toContain("{{ENVIRONMENT}}")
	})

	it("places environment section before project guidelines", () => {
		const contextFiles = [{ path: "/repo/AGENTS.md", content: "custom rule" }]
		const result = buildOrchestratorSystemPrompt(tools, testEnv, contextFiles)
		const envPos = result.indexOf("# Environment")
		const contextPos = result.indexOf("# Project Guidelines")
		expect(envPos).toBeLessThan(contextPos)
	})
})

describe("buildSubagentSystemPrompt", () => {
	const tools = [
		{ name: "read", description: "Read file contents" },
		{ name: "bash", description: "Execute bash commands" },
		{ name: "edit", description: "Edit files" },
		{ name: "write", description: "Write files" },
		{ name: "subagent", description: "Spawn an isolated subagent process" },
	]

	it("excludes the subagent tool", () => {
		const result = buildSubagentSystemPrompt(tools, testEnv)
		expect(result).not.toContain("subagent")
	})

	it("includes all other tools", () => {
		const result = buildSubagentSystemPrompt(tools, testEnv)
		expect(result).toContain("- read: Read file contents")
		expect(result).toContain("- bash: Execute bash commands")
		expect(result).toContain("- edit: Edit files")
		expect(result).toContain("- write: Write files")
	})

	it("replaces the {{TOOLS}} placeholder", () => {
		const result = buildSubagentSystemPrompt(tools, testEnv)
		expect(result).not.toContain("{{TOOLS}}")
	})

	it("contains coding assistant instructions", () => {
		const result = buildSubagentSystemPrompt(tools, testEnv)
		expect(result).toContain("expert coding assistant")
	})

	it("does not contain orchestration instructions", () => {
		const result = buildSubagentSystemPrompt(tools, testEnv)
		expect(result).not.toContain("orchestrator")
		expect(result).not.toContain("EASY")
		expect(result).not.toContain("HARD")
	})

	it("handles tools list with only the subagent tool", () => {
		const result = buildSubagentSystemPrompt([{ name: "subagent", description: "Spawn" }], testEnv)
		expect(result).toContain("(No tools available)")
	})

	it("replaces the {{PROJECT_CONTEXT}} placeholder when no context files", () => {
		const result = buildSubagentSystemPrompt(tools, testEnv)
		expect(result).not.toContain("{{PROJECT_CONTEXT}}")
	})

	it("injects project guidelines files into the prompt", () => {
		const contextFiles = [{ path: "/project/AGENTS.md", content: "Use TypeScript strict mode." }]
		const result = buildSubagentSystemPrompt(tools, testEnv, contextFiles)
		expect(result).toContain("# Project Guidelines")
		expect(result).toContain("Use TypeScript strict mode.")
		expect(result).not.toContain("/project/AGENTS.md")
	})

	it("places project guidelines after the guidelines section", () => {
		const contextFiles = [{ path: "/repo/AGENTS.md", content: "rule" }]
		const result = buildSubagentSystemPrompt(tools, testEnv, contextFiles)
		const guidelinesPos = result.indexOf("## Guidelines")
		const contextPos = result.indexOf("# Project Guidelines")
		expect(guidelinesPos).toBeLessThan(contextPos)
	})

	it("replaces the {{SKILLS}} placeholder when no skills", () => {
		const result = buildSubagentSystemPrompt(tools, testEnv)
		expect(result).not.toContain("{{SKILLS}}")
	})

	it("injects skills into the prompt", () => {
		const skills = [createSkill({ name: "deploy", description: "Deploy the app" })]
		const result = buildSubagentSystemPrompt(tools, testEnv, undefined, skills)
		expect(result).toContain("available_skills")
		expect(result).toContain("deploy")
		expect(result).toContain("Deploy the app")
	})

	it("injects environment info into the prompt", () => {
		const result = buildSubagentSystemPrompt(tools, testEnv)
		expect(result).toContain("# Environment")
		expect(result).toContain(`OS: ${testEnv.os}`)
		expect(result).toContain(`Username: ${testEnv.username}`)
		expect(result).toContain(`Home directory: "${testEnv.homeDir}"`)
		expect(result).toContain(`Working directory: "${testEnv.cwd}"`)
		expect(result).toContain(`Current time: ${testEnv.currentTime} (local date: ${testEnv.localDate})`)
		expect(result).toContain("Git repository: no")
	})

	it("injects git branch and remote when present", () => {
		const gitEnv: EnvironmentInfo = {
			...testEnv,
			isGitRepo: true,
			gitBranch: "feature/my-branch",
			gitRemote: "https://github.com/org/repo.git",
		}
		const result = buildSubagentSystemPrompt(tools, gitEnv)
		expect(result).toContain("Git repository: yes")
		expect(result).toContain("Git branch: feature/my-branch")
		expect(result).toContain("Git remote: https://github.com/org/repo.git")
	})

	it("replaces the {{ENVIRONMENT}} placeholder", () => {
		const result = buildSubagentSystemPrompt(tools, testEnv)
		expect(result).not.toContain("{{ENVIRONMENT}}")
	})
})

describe("phase guideline resolution", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("returns default guideline when no model is specified", () => {
		const result = resolvePhaseGuideline("build", undefined, registry)
		expect(result).toContain("During **build** phase")
		expect(result).toContain("Read each file BEFORE modifying it")
	})

	it("returns model-specific override when model has one", () => {
		const result = resolvePhaseGuideline("build", "minimax-m2.7", registry)
		// Should contain default build guidelines
		expect(result).toContain("During **build** phase:")
		// Should contain MiniMax family guidelines
		expect(result).toContain("MiniMax M2 family")
		expect(result).toContain("Outline-then-diff")
		// Should contain M2.7-specific guidelines
		expect(result).toContain("minimax-m2.7 specific")
		expect(result).toContain("mutex-based concurrency")
	})

	it("falls back to default for phases with no model override", () => {
		// minimax-m2.7 has no explore override
		const result = resolvePhaseGuideline("explore", "minimax-m2.7", registry)
		expect(result).toContain("During **explore** phase")
		expect(result).not.toContain("minimax")
	})

	it("returns default for unknown model IDs", () => {
		const result = resolvePhaseGuideline("plan", "nonexistent-model", registry)
		expect(result).toContain("During **plan** phase")
		expect(result).toContain("Design BEFORE coding")
	})

	it("composes all three layers for kimi-k2.6 plan", () => {
		const result = resolvePhaseGuideline("plan", "kimi-k2.6", registry)
		// Default layer
		expect(result).toContain("Design BEFORE coding")
		// Family plan layer
		expect(result).toContain("Kimi family")
		expect(result).toContain("Chunks")
		// K2.6-specific layer
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
		// Family layer
		expect(result).toContain("Kimi family")
		expect(result).toContain("delegation sequence")
		// K2.6-specific layer
		expect(result).toContain("kimi-k2.6 specific")
		expect(result).toContain("chunk")
	})

	it("returns composed orchestration guideline for kimi-k2.5", () => {
		const result = resolveOrchestrationGuideline("kimi-k2.5", registry)
		// Family layer
		expect(result).toContain("Kimi family")
		// K2.5-specific layer
		expect(result).toContain("kimi-k2.5 specific")
		expect(result).toContain("tool-call reliability")
	})

	it("returns composed orchestration guideline for claude-opus-4-7", () => {
		const result = resolveOrchestrationGuideline("claude-opus-4-7", registry)
		expect(result).toContain("Claude family")
		expect(result).toContain("delegation granularity")
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

describe("guideline injection into system prompts", () => {
	const tools = [{ name: "read", description: "Read file contents" }]
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	it("injects orchestration guidelines into orchestrator prompt for known models", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv, undefined, undefined, {
			currentModelId: "minimax-m2.7",
			registry,
		})
		expect(result).toContain("## Orchestration Guidelines")
		expect(result).toContain("web_search")
	})

	it("omits orchestration section when no model context is provided", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv)
		expect(result).not.toContain("## Orchestration Guidelines")
	})

	it("does not inject orchestration guidelines into single-model prompt", () => {
		const result = buildSingleModelSystemPrompt(tools, testEnv, undefined, undefined, {
			currentModelId: "minimax-m2.7",
			registry,
		})
		expect(result).not.toContain("## Orchestration Guidelines")
	})

	it("does not inject orchestration guidelines into subagent prompt", () => {
		const result = buildSubagentSystemPrompt(tools, testEnv, undefined, undefined, {
			currentModelId: "minimax-m2.7",
			registry,
		})
		expect(result).not.toContain("## Orchestration Guidelines")
	})

	it("injects phase guidelines into orchestrator prompt when phase is set", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv, undefined, undefined, {
			currentModelId: "minimax-m2.7",
			currentPhase: "build",
			registry,
		})
		expect(result).toContain("## Phase Guidelines (build)")
		expect(result).toContain("Outline-then-diff")
	})

	it("places orchestration section before phase section", () => {
		const result = buildOrchestratorSystemPrompt(tools, testEnv, undefined, undefined, {
			currentModelId: "minimax-m2.7",
			currentPhase: "build",
			registry,
		})
		const orchPos = result.indexOf("## Orchestration Guidelines")
		const phasePos = result.indexOf("## Phase Guidelines")
		expect(orchPos).toBeGreaterThan(-1)
		expect(phasePos).toBeGreaterThan(-1)
		expect(orchPos).toBeLessThan(phasePos)
	})
})

describe("builtin-model guideline content", () => {
	const registry = new ModelRegistry(ALL_KNOWN_METADATA)

	// kimi-k2.5: build = default + Kimi family + K2.5-specific
	it("kimi-k2.5 build: contains default, family, and per-model layers", () => {
		const result = resolvePhaseGuideline("build", "kimi-k2.5", registry)
		expect(result).toContain("During **build** phase:")
		expect(result).toContain("Plan-first")
		expect(result).toContain("well-formed tool calls")
	})

	// kimi-k2.5: explore removed from strengths → falls back to default
	it("kimi-k2.5 explore: falls back to default (no per-model explore)", () => {
		const result = resolvePhaseGuideline("explore", "kimi-k2.5", registry)
		expect(result).toContain("During **explore** phase:")
		expect(result).not.toContain("Plan-first")
	})

	// kimi-k2.6: plan = default + family + K2.6-specific
	it("kimi-k2.6 plan: contains default, family, and per-model layers", () => {
		const result = resolvePhaseGuideline("plan", "kimi-k2.6", registry)
		expect(result).toContain("Design BEFORE coding")
		expect(result).toContain("Chunks")
		expect(result).toContain("per-chunk acceptance criteria")
	})

	// minimax-m2.7: build = default + family + per-model
	it("minimax-m2.7 build: contains default, family, and per-model layers", () => {
		const result = resolvePhaseGuideline("build", "minimax-m2.7", registry)
		expect(result).toContain("During **build** phase:")
		expect(result).toContain("Outline-then-diff")
		expect(result).toContain("mutex")
	})

	// minimax-m2.7: review = default + family + per-model
	it("minimax-m2.7 review: contains default, family, and per-model layers", () => {
		const result = resolvePhaseGuideline("review", "minimax-m2.7", registry)
		expect(result).toContain("During **review** phase:")
		expect(result).toContain("scope creep")
		expect(result).toContain("hallucinated APIs")
		expect(result).toContain("inappropriate concurrency")
	})

	// nemotron-3-super-fp4: build = default + family + per-model
	it("nemotron-3-super-fp4 build: contains default, family, and per-model layers", () => {
		const result = resolvePhaseGuideline("build", "nemotron-3-super-fp4", registry)
		expect(result).toContain("long context window")
		expect(result).toContain("strictly within the spec")
	})

	// claude-opus-4-7: plan = default + family + per-model
	it("claude-opus-4-7 plan: contains default, family, and per-model layers", () => {
		const result = resolvePhaseGuideline("plan", "claude-opus-4-7", registry)
		expect(result).toContain("Design BEFORE coding")
		expect(result).toContain("Match plan depth")
		expect(result).toContain("Don't relitigate")
	})

	// claude-opus-4-7: explore = default + family + per-model
	it("claude-opus-4-7 explore: contains default, family, and per-model layers", () => {
		const result = resolvePhaseGuideline("explore", "claude-opus-4-7", registry)
		expect(result).toContain("During **explore** phase:")
		expect(result).toContain("Resist over-exploration")
	})

	// verify co-author trailer is present in build guidelines
	it("default build guidelines contain the co-author trailer", () => {
		const result = resolvePhaseGuideline("build", undefined, registry)
		expect(result).toContain("Co-Authored-By: Kimchi <noreply@kimchi.dev>")
	})
})
