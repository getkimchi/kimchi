import type { Skill } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../orchestration/model-registry/index.js"
import { type EnvironmentInfo, buildSystemPrompt, formatEnvironmentSection } from "./system-prompt.js"

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
	osRelease: "6.1.0-test",
	osVersion: "#1 SMP PREEMPT_DYNAMIC Test",
	username: "testuser",
	homeDir: "/home/testuser",
	cwd: "/home/testuser/projects/myapp",
	documentsDir: "/home/testuser/projects/myapp/.kimchi/docs",
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

describe("formatEnvironmentSection", () => {
	it("prints stable environment context lines", () => {
		expect(formatEnvironmentSection(testEnv)).toBe(
			[
				"## Environment",
				"",
				"- OS: Linux",
				"- OS release: 6.1.0-test",
				"- OS version: #1 SMP PREEMPT_DYNAMIC Test",
				"- Raw platform: linux",
				"- CPU architecture: x64",
				"- Shell: /bin/bash",
				"- Shell family: posix",
				"- Command guidance: Use commands compatible with the shell family. Do not use PowerShell/cmd syntax in POSIX shells, and do not use POSIX-only syntax in PowerShell/cmd unless the shell is Git Bash or WSL. If shell/platform conflict or are unclear, check with a read-only command before running write/destructive commands.",
				"- Username: testuser",
				'- Home directory: "/home/testuser"',
				'- Working directory: "/home/testuser/projects/myapp"',
				'- Documents directory: "/home/testuser/projects/myapp/.kimchi/docs"',
				"- Current date: 2026-01-01",
				"- Git repository: no",
			].join("\n"),
		)
	})

	it("classifies shell families from platform and shell", () => {
		expect(formatEnvironmentSection({ ...testEnv, rawPlatform: "darwin", shell: "/bin/zsh" })).toContain(
			"- Shell family: posix",
		)
		expect(formatEnvironmentSection({ ...testEnv, rawPlatform: "win32", shell: "pwsh.exe" })).toContain(
			"- Shell family: powershell",
		)
		expect(
			formatEnvironmentSection({ ...testEnv, rawPlatform: "win32", shell: "C:\\Program Files\\Git\\bin\\bash.exe" }),
		).toContain("- Shell family: posix-on-windows")
	})
})

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
		{ name: "Agent", description: "Launch a specialized agent" },
		{ name: "get_subagent_result", description: "Get background agent result" },
		{ name: "steer_subagent", description: "Steer a running background agent" },
	]

	describe("orchestrator mode", () => {
		it("includes all expected sections", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "orchestrator",
			})
			expect(result).toContain("You are Kimchi, an AI coding agent")
			expect(result).toContain("# Environment")
			expect(result).toContain("## Available Tools")
			expect(result).toContain("## Documents")
			expect(result).toContain("## Guidelines")
			expect(result).toContain("Orchestrate the work")
			expect(result).toContain("Token budgets")
			expect(result).toContain("token_budget")
		})

		it("includes all tool names and descriptions", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "orchestrator",
			})
			expect(result).toContain('<tool name="read">')
			expect(result).toContain('<tool name="Agent">')
		})

		it("does not include phase tagging instructions without the tags extension", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "orchestrator",
			})

			expect(result).not.toContain("Phase Tagging for Analytics")
			expect(result).not.toContain("You must call `set_phase`")
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

		it("places global context files before project context files", () => {
			const contextFiles = [
				{ path: "/home/testuser/.config/kimchi/harness/AGENTS.md", content: "Global rule" },
				{ path: "/repo/AGENTS.md", content: "Project rule" },
			]
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				contextFiles,
				mode: "orchestrator",
			})
			const globalPos = result.indexOf("Global rule")
			const projectPos = result.indexOf("Project rule")
			expect(globalPos).toBeGreaterThan(-1)
			expect(projectPos).toBeGreaterThan(-1)
			expect(globalPos).toBeLessThan(projectPos)
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
			expect(result).toContain(`OS release: ${testEnv.osRelease}`)
			expect(result).toContain(`OS version: ${testEnv.osVersion}`)
			expect(result).toContain(`Raw platform: ${testEnv.rawPlatform}`)
			expect(result).toContain(`CPU architecture: ${testEnv.cpuArchitecture}`)
			expect(result).toContain(`Shell: ${testEnv.shell}`)
			expect(result).toContain(`Username: ${testEnv.username}`)
			expect(result).toContain(`Home directory: "${testEnv.homeDir}"`)
			expect(result).toContain(`Working directory: "${testEnv.cwd}"`)
			expect(result).toContain(`Current date: ${testEnv.localDate}`)
			expect(result).not.toContain("Current time:")
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
		})

		it("includes orchestration guidelines when model is provided", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				registry,
				mode: "orchestrator",
			})
			expect(result).toContain("### Orchestration Guidelines")
			expect(result).toContain("MiniMax M2 family")
		})

		it("includes both phase guidelines and orchestration guidelines in orchestrator mode", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				currentPhase: "build",
				registry,
				mode: "orchestrator",
			})
			expect(result).toContain("## Phase Guidelines (build)")
			expect(result).toContain("### Orchestration Guidelines")
		})
	})

	describe("subagent mode", () => {
		it("excludes delegation tools", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
			expect(result).not.toContain('<tool name="Agent">')
			expect(result).not.toContain('<tool name="get_subagent_result">')
			expect(result).not.toContain('<tool name="steer_subagent">')
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
			expect(result).not.toContain("Tool and MCP Discovery")
		})

		it("does not contain orchestration instructions", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
			expect(result).not.toContain("Orchestrate the work")
			expect(result).not.toContain("Model selection for delegation")
		})

		it("includes phase guidelines when phase and model are provided", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				currentPhase: "build",
				registry,
				mode: "subagent",
			})
			expect(result).toContain("## Phase Guidelines (build)")
			expect(result).toContain("Outline-then-diff")
		})

		it("handles tools list with only delegation tools", () => {
			const result = buildSystemPrompt({
				tools: [
					{ name: "Agent", description: "Launch" },
					{ name: "get_subagent_result", description: "Get result" },
				],
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
			expect(result).toContain(`OS release: ${testEnv.osRelease}`)
			expect(result).toContain(`OS version: ${testEnv.osVersion}`)
			expect(result).toContain(`Raw platform: ${testEnv.rawPlatform}`)
			expect(result).toContain(`CPU architecture: ${testEnv.cpuArchitecture}`)
			expect(result).toContain(`Shell: ${testEnv.shell}`)
			expect(result).toContain(`Username: ${testEnv.username}`)
			expect(result).toContain(`Home directory: "${testEnv.homeDir}"`)
			expect(result).toContain(`Working directory: "${testEnv.cwd}"`)
			expect(result).toContain(`Current date: ${testEnv.localDate}`)
			expect(result).not.toContain("Current time:")
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
			expect(result).not.toContain("Orchestrate the work")
			expect(result).not.toContain("Model selection for delegation")
			expect(result).not.toContain("Token budgets")
			expect(result).not.toContain("Sharing context between agents")
			expect(result).not.toContain("Subagent response protocol")
			expect(result).toContain("Single-Model Mode")
		})

		it("includes core sections", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "single",
			})
			expect(result).toContain("You are Kimchi, an AI coding agent")
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
			expect(result).toContain('<tool name="Agent">')
		})

		it("includes phase guidelines when phase and model are provided", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				currentPhase: "build",
				registry,
				mode: "single",
			})
			expect(result).toContain("## Phase Guidelines (build)")
			expect(result).toContain("Outline-then-diff")
		})

		it("includes default research nudges for a non-OSS model in research phase", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "claude-opus-4-6-20250514",
				currentPhase: "research",
				registry,
				mode: "single",
			})
			expect(result).toContain("## Phase Guidelines (research)")
			expect(result).toContain("version you are assuming")
			expect(result).toContain("version/API assumption")
			expect(result).toContain("do not bluff")
			expect(result).toContain("Do not rely on training memory")
			expect(result).not.toContain("AT MOST one")
		})

		it("includes default and family research nudges for an OSS model in research phase", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				currentPhase: "research",
				registry,
				mode: "single",
			})
			expect(result).toContain("## Phase Guidelines (research)")
			expect(result).toContain("MiniMax family")
			expect(result).toContain("hallucinating APIs")
			expect(result).toContain("version you are assuming")
		})

		it("includes build-phase research nudge for an OSS model in build phase", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				currentPhase: "build",
				registry,
				mode: "single",
			})
			expect(result).toContain("## Phase Guidelines (build)")
			expect(result).toContain("uncertain about a library API")
			expect(result).toContain("assume your knowledge may be stale")
		})
	})
})
