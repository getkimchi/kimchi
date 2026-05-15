import type { Skill } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../orchestration/model-registry/index.js"
import { type EnvironmentInfo, buildSystemPrompt } from "./system-prompt.js"

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

const registry = new ModelRegistry(ALL_KNOWN_METADATA)

function createSkill(overrides: Partial<Skill> & { name: string; description: string }): Skill {
	return {
		filePath: `/skills/${overrides.name}/SKILL.md`,
		baseDir: `/skills/${overrides.name}`,
		sourceInfo: { path: `/skills/${overrides.name}/SKILL.md`, source: "local", scope: "project", origin: "top-level" },
		disableModelInvocation: false,
		...overrides,
	}
}

describe("buildSystemPrompt", () => {
	const tools = [
		{ name: "read", description: "Read file contents" },
		{ name: "bash", description: "Execute bash commands" },
		{ name: "subagent", description: "Spawn an isolated subagent process" },
	]

	describe("orchestrator mode", () => {
		it("includes all expected sections", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "orchestrator",
			})
			expect(result).toContain("You are an expert coding assistant")
			expect(result).toContain("# Environment")
			expect(result).toContain("## Available Tools")
			expect(result).toContain("## Documents")
			expect(result).toContain("## Guidelines")
			expect(result).toContain("Orchestrate the work")
			expect(result).toContain("Sharing context between agents")
			expect(result).toContain("Subagent delegation rules")
			expect(result).toContain("Model selection for delegation")
			expect(result).toContain("Token budgets")
			expect(result).toContain("Inactivity timeout")
		})

		it("includes all tool names and descriptions", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "orchestrator",
			})
			expect(result).toContain('<tool name="read">')
			expect(result).toContain('<tool name="subagent">')
		})

		it("handles empty tools list", () => {
			const result = buildSystemPrompt({
				tools: [],
				env: testEnv,
				mode: "orchestrator",
			})
			expect(result).toContain("(No tools available)")
		})

		it("injects project context files", () => {
			const contextFiles = [{ path: "/repo/AGENTS.md", content: "Always run tests before committing." }]
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				contextFiles,
				mode: "orchestrator",
			})
			expect(result).toContain("# Project Guidelines")
			expect(result).toContain("Always run tests before committing.")
		})

		it("injects skills", () => {
			const skills = [createSkill({ name: "deploy", description: "Deploy the app to production" })]
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				skills,
				mode: "orchestrator",
			})
			expect(result).toContain("available_skills")
			expect(result).toContain("deploy")
			expect(result).toContain("Deploy the app to production")
		})

		it("excludes skills with disableModelInvocation", () => {
			const skills = [
				createSkill({ name: "safe-skill", description: "Visible skill" }),
				createSkill({ name: "hidden-skill", description: "Hidden skill", disableModelInvocation: true }),
			]
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				skills,
				mode: "orchestrator",
			})
			expect(result).toContain("safe-skill")
			expect(result).not.toContain("hidden-skill")
		})

		it("injects environment info", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "orchestrator",
			})
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
			const result = buildSystemPrompt({
				tools,
				env: gitEnv,
				mode: "orchestrator",
			})
			expect(result).toContain("Git repository: yes")
			expect(result).toContain("Git branch: main")
			expect(result).toContain("Git remote: git@github.com:org/repo.git")
		})

		it("omits git branch and remote when not a git repo", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "orchestrator",
			})
			expect(result).not.toContain("Git branch:")
			expect(result).not.toContain("Git remote:")
		})

		it("places environment section before project guidelines", () => {
			const contextFiles = [{ path: "/repo/AGENTS.md", content: "custom rule" }]
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				contextFiles,
				mode: "orchestrator",
			})
			const envPos = result.indexOf("# Environment")
			const contextPos = result.indexOf("# Project Guidelines")
			expect(envPos).toBeLessThan(contextPos)
		})

		it("includes phase guidelines when phase is provided", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m2.7",
				currentPhase: "build",
				registry,
				mode: "orchestrator",
			})
			expect(result).toContain("## Phase Guidelines (build)")
			expect(result).toContain("Outline-then-diff")
		})

		it("includes orchestration guidelines when model is provided", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m2.7",
				registry,
				mode: "orchestrator",
			})
			expect(result).toContain("### Orchestration Guidelines")
			expect(result).toContain("MiniMax M2 family")
		})

		it("places orchestration section before phase section", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m2.7",
				currentPhase: "build",
				registry,
				mode: "orchestrator",
			})
			const orchPos = result.indexOf("### Orchestration Guidelines")
			const phasePos = result.indexOf("## Phase Guidelines")
			expect(orchPos).toBeGreaterThan(-1)
			expect(phasePos).toBeGreaterThan(-1)
			expect(orchPos).toBeLessThan(phasePos)
		})
	})

	describe("subagent mode", () => {
		it("excludes the subagent tool", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
			expect(result).not.toContain("subagent")
		})

		it("includes all other tools", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
			expect(result).toContain('<tool name="read">')
			expect(result).toContain('<tool name="bash">')
		})

		it("contains subagent instructions", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
			expect(result).toContain("Subagent response protocol")
			expect(result).toContain('{"summary":')
			expect(result).toContain("Factual Accuracy")
			expect(result).toContain("Tool and MCP Discovery")
		})

		it("does not contain orchestration instructions", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
			expect(result).not.toContain("Subagent delegation rules")
			expect(result).not.toContain("Model selection for delegation")
		})

		it("handles tools list with only the subagent tool", () => {
			const result = buildSystemPrompt({
				tools: [{ name: "subagent", description: "Spawn" }],
				env: testEnv,
				mode: "subagent",
			})
			expect(result).toContain("(No tools available)")
		})

		it("injects project context files", () => {
			const contextFiles = [{ path: "/project/AGENTS.md", content: "Use TypeScript strict mode." }]
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				contextFiles,
				mode: "subagent",
			})
			expect(result).toContain("# Project Guidelines")
			expect(result).toContain("Use TypeScript strict mode.")
		})

		it("injects skills", () => {
			const skills = [createSkill({ name: "deploy", description: "Deploy the app" })]
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				skills,
				mode: "subagent",
			})
			expect(result).toContain("available_skills")
			expect(result).toContain("deploy")
		})

		it("injects environment info", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
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
			const result = buildSystemPrompt({
				tools,
				env: gitEnv,
				mode: "subagent",
			})
			expect(result).toContain("Git repository: yes")
			expect(result).toContain("Git branch: feature/my-branch")
			expect(result).toContain("Git remote: https://github.com/org/repo.git")
		})
	})

	describe("single-model mode", () => {
		it("does not contain orchestration instructions", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "single",
			})
			expect(result).not.toContain("Subagent delegation rules")
			expect(result).not.toContain("Model selection for delegation")
			expect(result).not.toContain("Token budgets")
			expect(result).not.toContain("Orchestrate the work")
			expect(result).not.toContain("Sharing context between agents")
			expect(result).not.toContain("Subagent response protocol")
		})

		it("includes core sections", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "single",
			})
			expect(result).toContain("You are an expert coding assistant")
			expect(result).toContain("# Environment")
			expect(result).toContain("## Available Tools")
			expect(result).toContain("## Documents")
			expect(result).toContain("## Guidelines")
		})

		it("includes all tools", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "single",
			})
			expect(result).toContain('<tool name="read">')
			expect(result).toContain('<tool name="bash">')
			expect(result).toContain('<tool name="subagent">')
		})

		it("includes phase guidelines when phase is provided", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m2.7",
				currentPhase: "build",
				registry,
				mode: "single",
			})
			expect(result).toContain("## Phase Guidelines (build)")
			expect(result).toContain("Outline-then-diff")
		})
	})
})
