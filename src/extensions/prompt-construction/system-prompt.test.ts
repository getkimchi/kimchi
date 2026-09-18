import type { Skill } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import type { ModelMetadata } from "../../models.js"
import { MODEL_CAPABILITIES, ModelRegistry } from "../orchestration/model-registry/index.js"
import { DEFAULT_MODEL_ROLES } from "../orchestration/model-roles.js"
import { ORCHESTRATOR_SUPPRESSED_SKILL_NAMES } from "./orchestrator-suppressed-skills.js"
import { buildSystemPrompt, type EnvironmentInfo, formatEnvironmentSection } from "./system-prompt.js"

const testEnv: EnvironmentInfo = {
	os: "Linux",
	rawPlatform: "linux",
	cpuArchitecture: "x64",
	shell: "/bin/bash",
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
				"- OS version: #1 SMP PREEMPT_DYNAMIC Test",
				"- Platform: linux",
				"- CPU architecture: x64",
				"- Shell: /bin/bash",
				"- Username: testuser",
				'- Home directory: "/home/testuser"',
				'- Working directory: "/home/testuser/projects/myapp"',
				'- Documents directory: "/home/testuser/projects/myapp/.kimchi/docs"',
				"- Current date: 2026-01-01",
				"- Git repository: no",
			].join("\n"),
		)
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

	it("scopes consent requirements without blocking requested local development work", () => {
		const result = buildSystemPrompt({
			tools,
			env: testEnv,
			mode: "single",
		})

		expect(result).toContain(
			"A user's request to change code authorizes ordinary local workspace edits and verification commands",
		)
		expect(result).toContain("Internal planning artifacts such as todo lists never grant approval")
		expect(result).not.toContain("Ask before anything that publishes, mutates state, or is irreversible.")
	})

	it("scopes approval to the requested action, not escalations or substitutes", () => {
		const result = buildSystemPrompt({
			tools,
			env: testEnv,
			mode: "single",
		})

		expect(result).toContain("Approval covers exactly the action the user requested")
		expect(result).toContain('A request to "push" does not authorize opening a pull request')
		expect(result).toContain("wait for the user to choose")
	})

	it("does not treat investigate-or-plan requests as implementation approval", () => {
		const result = buildSystemPrompt({
			tools,
			env: testEnv,
			mode: "single",
		})

		expect(result).toContain(
			"A request to investigate an issue, evaluate options, or draft a plan authorizes only the analysis",
		)
		expect(result).toContain("wait for the user's go-ahead before writing or modifying code")
	})

	it("includes the harness notes and approval section", () => {
		const result = buildSystemPrompt({
			tools,
			env: testEnv,
			mode: "single",
		})

		expect(result).toContain("## Harness Notes and Approval")
		expect(result).toContain("<system-reminder>...")
		expect(result).toContain("</system-reminder>")
		expect(result).toContain("never grant approval")
		expect(result).toContain("verbatim quote of your own previous assistant message")
	})

	it("caps GitLab merge request diffs before targeted reads", () => {
		const result = buildSystemPrompt({
			tools,
			env: testEnv,
			mode: "single",
		})

		expect(result).toContain("Big PR/MR diffs: list changed paths first, then targeted reads")
		expect(result).toContain("--paginate")
		expect(result).not.toContain("merge_requests/123/changes")
	})

	describe("orchestrator mode", () => {
		it("includes all expected sections", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "orchestrator",
			})
			expect(result).toContain("You are Kimchi, an AI coding agent")
			expect(result).toContain("# Environment")
			expect(result).not.toContain("## Documents")
			expect(result).toContain("## Guidelines")
			expect(result).toContain("## Orchestration")
			expect(result).toContain("Token budgets")
			expect(result).toContain("token_budget")
		})

		it("includes all tool names (descriptions live in the API payload)", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "orchestrator",
			})
			// Descriptions are intentionally not duplicated in the prompt: the API
			// tools parameter already carries them.
			expect(result).not.toContain("<available_tools>")
			expect(result).not.toContain("Launch a specialized agent")
		})

		it("omits the Phase Management payload for orchestrators with owned phases", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "kimi-k2.7",
				roles: DEFAULT_MODEL_ROLES,
				mode: "orchestrator",
			})

			expect(result).not.toContain("Phase Tagging for Analytics")
			expect(result).not.toContain("Call `set_phase`")
			// Phase guidelines were removed from the prompt (persona/role guidance
			// still covers working practices).
			expect(result).not.toContain("### Phase-specific behaviour")
			expect(result).not.toContain("During **plan** phase")
		})

		it("handles empty tools list", () => {
			const result = buildSystemPrompt({
				tools: [],
				env: testEnv,
				mode: "orchestrator",
			})
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
			expect(result).not.toContain(`OS release:`)
			expect(result).toContain(`OS version: ${testEnv.osVersion}`)
			expect(result).toContain(`Platform: ${testEnv.rawPlatform}`)
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

		it("omits phase management when no phase tool or owned phase behaviour applies", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "orchestrator",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **explore** phase")
			expect(result).not.toContain("During **research** phase")
			expect(result).not.toContain("During **plan** phase")
			expect(result).not.toContain("During **build** phase")
			expect(result).not.toContain("During **review** phase")
		})

		it("omits phase behaviour even for phases the orchestrator may perform directly", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "kimi-k2.7",
				registry,
				roles: DEFAULT_MODEL_ROLES,
				mode: "orchestrator",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **plan** phase")
			expect(result).not.toContain("During **explore** phase")
			expect(result).not.toContain("During **review** phase")
		})

		it("uses orchestrator-specific core guidelines", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				roles: DEFAULT_MODEL_ROLES,
				mode: "orchestrator",
			})
			expect(result).toContain("Follow **Orchestration** for what to do yourself vs delegate")
			expect(result).not.toContain("Provide complete, functional code")
		})

		it("suppresses conflicting superpowers skills in orchestrator mode", () => {
			const skills = [
				createSkill({ name: "brainstorming", description: "Brainstorm" }),
				createSkill({ name: "subagent-driven-development", description: "Alternate delegation workflow" }),
			]
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				skills,
				roles: DEFAULT_MODEL_ROLES,
				mode: "orchestrator",
			})
			expect(result).toContain("brainstorming")
			expect(result).not.toContain("subagent-driven-development")
		})

		it("documents the canonical names of suppressed orchestrator-conflicting skills", () => {
			expect([...ORCHESTRATOR_SUPPRESSED_SKILL_NAMES].sort()).toEqual([
				"dispatching-parallel-agents",
				"executing-plans",
				"finishing-a-development-branch",
				"receiving-code-review",
				"requesting-code-review",
				"subagent-driven-development",
				"systematic-debugging",
				"test-driven-development",
				"verification-before-completion",
				"writing-plans",
			])
		})

		it("includes thinking levels in orchestrator mode", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				registry,
				mode: "orchestrator",
			})
			expect(result).toContain("### Thinking levels")
			expect(result).toContain("| Build chunk | Builder |")
		})

		it("includes model-specific orchestration notes when model is provided", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				registry,
				mode: "orchestrator",
			})
			expect(result).toContain("### Model-specific notes")
			expect(result).toContain("MiniMax M2 family")
		})

		it("includes Phase Management section alongside model-specific orchestration notes", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				registry,
				roles: {
					...DEFAULT_MODEL_ROLES,
					orchestrator: "kimchi-dev/minimax-m3",
					planner: "kimchi-dev/minimax-m3",
				},
				mode: "orchestrator",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **plan** phase")
			expect(result).toContain("### Model-specific notes")
		})
	})

	describe("subagent mode", () => {
		it("excludes delegation tools", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
			expect(result).not.toContain("Agent, ")
			expect(result).not.toContain("get_subagent_result")
			expect(result).not.toContain("steer_subagent")
		})

		it("does not list tool names either", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
			expect(result).not.toContain("## Available Tools")
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
			expect(result).not.toContain("## Orchestration")
			expect(result).not.toContain("Model selection for delegation")
		})

		it("omits the Phase Management payload even when a model is provided", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				registry,
				mode: "subagent",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **build** phase")
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
			expect(result).not.toContain(`OS release:`)
			expect(result).toContain(`OS version: ${testEnv.osVersion}`)
			expect(result).toContain(`Platform: ${testEnv.rawPlatform}`)
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
			expect(result).not.toContain("## Orchestration")
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
			expect(result).not.toContain("## Documents")
			expect(result).toContain("## Guidelines")
		})

		it("does not list tool names (the API tools payload owns discovery)", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "single",
			})
			expect(result).not.toContain("## Available Tools")
		})

		// Interactive single-model sessions expose set_phase — phase payloads are
		// paid only when the tool is reachable.
		const phaseTools = [...tools, { name: "set_phase", description: "Tag the current work phase" }]

		it("omits the Phase Management payload even when the set_phase tool is reachable", () => {
			const result = buildSystemPrompt({
				tools: phaseTools,
				env: testEnv,
				currentModelId: "minimax-m3",
				registry,
				mode: "single",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **build** phase")
			expect(result).not.toContain("During **research** phase")
		})

		it("drops the entire phase payload in single-model sessions without set_phase", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				registry,
				mode: "single",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **build** phase")
			expect(result).not.toContain("During **research** phase")
			expect(result).not.toContain("Call `set_phase`")
			// The tool-independent safety rules that used to ride the phase payload
			// are hoisted to CORE_GUIDELINES, so a --print session still sees them.
			expect(result).toContain("Co-Authored-By: Kimchi <noreply@kimchi.dev>")
			expect(result).toContain("the bash tool's `timeout` parameter")
			expect(result).toContain("avoid interactive CLI flags")
		})

		it("keeps Phase Management out of subagent mode too", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				registry,
				mode: "subagent",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **build** phase")
		})

		it("omits research-phase guidelines for a non-OSS model", () => {
			const result = buildSystemPrompt({
				tools: phaseTools,
				env: testEnv,
				currentModelId: "claude-opus-4-6-20250514",
				registry,
				mode: "single",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **research** phase")
		})

		it("omits research-phase guidelines (and family overrides) for an OSS model", () => {
			const result = buildSystemPrompt({
				tools: phaseTools,
				env: testEnv,
				currentModelId: "minimax-m3",
				registry,
				mode: "single",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **research** phase")
			expect(result).not.toContain("hallucinating APIs")
		})

		it("omits build-phase guidelines (and family overrides) for an OSS model", () => {
			const result = buildSystemPrompt({
				tools: phaseTools,
				env: testEnv,
				currentModelId: "minimax-m3",
				registry,
				mode: "single",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **build** phase")
			expect(result).not.toContain("STAY IN SCOPE")
		})

		it("makes subagent spawning opt-in and defaults to the current model", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				mode: "single",
			})
			// New behavior: default is to handle work directly, do not spawn subagents.
			expect(result).toContain("handle tasks directly yourself")
			expect(result).toContain("Only spawn `Agent` subagents")
			expect(result).toContain("Only spawn `Agent` subagents when the user explicitly asks")
			// When a subagent IS spawned, default to the parent's model unless a
			// different model is explicitly instructed.
			expect(result).toContain("pass your own model ID")
			// Old autonomous-delegate phrasing must be gone.
			expect(result).not.toContain("clearly beneficial")
			expect(result).not.toContain("MUST always pass")
			expect(result).not.toContain("never delegate to a different model")
		})
	})

	describe("hasUserLoop gating", () => {
		it("defaults to user-present behavior when hasUserLoop is omitted", () => {
			const result = buildSystemPrompt({ tools, env: testEnv, mode: "single" })
			expect(result).toContain("## Consent & Irreversible Actions")
			expect(result).toContain("## Harness Notes and Approval")
			expect(result).not.toContain("## Documents")
			expect(result).toContain("orients the user")
			expect(result).not.toContain("## Autonomous Session")
		})

		it("keeps interactive sections when hasUserLoop is true", () => {
			const result = buildSystemPrompt({ tools, env: testEnv, mode: "single", hasUserLoop: true })
			expect(result).toContain("## Consent & Irreversible Actions")
			expect(result).toContain("## Harness Notes and Approval")
			expect(result).not.toContain("## Documents")
			expect(result).not.toContain("## Autonomous Session")
		})

		it("replaces user-presence-only sections in userless sessions", () => {
			const result = buildSystemPrompt({ tools, env: testEnv, mode: "single", hasUserLoop: false })
			expect(result).not.toContain("## Consent & Irreversible Actions")
			expect(result).not.toContain("## Harness Notes and Approval")
			expect(result).not.toContain("## Documents")
			expect(result).toContain("## Autonomous Session")
			expect(result).toContain("fully autonomous with no human available")
			expect(result).toContain("Proceed without asking for approval")
		})

		it("drops the orient-the-user ritual in userless single-model sessions", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "single",
				hasUserLoop: false,
				currentModelId: "kimi-k3",
			})
			expect(result).not.toContain("orients the user")
			expect(result).not.toContain("user's window to interrupt")
			// The non-interactive core of the single-model section stays.
			expect(result).toContain("## Single-Model Mode")
			expect(result).toContain("Your model ID is `kimi-k3`")
			expect(result).toContain("Only spawn `Agent` subagents")
		})

		it("keeps task-execution sections regardless of the gate", () => {
			const gated = buildSystemPrompt({ tools, env: testEnv, mode: "single", hasUserLoop: false })
			expect(gated).toContain("## Guidelines")
			expect(gated).toContain("## Tool Selection")
			expect(gated).toContain("## Environment")
		})

		it("is significantly smaller in userless sessions", () => {
			const interactive = buildSystemPrompt({ tools, env: testEnv, mode: "single", hasUserLoop: true })
			const headless = buildSystemPrompt({ tools, env: testEnv, mode: "single", hasUserLoop: false })
			expect(interactive.length - headless.length).toBeGreaterThan(1500)
		})
	})
})
