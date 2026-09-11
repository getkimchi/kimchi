import type { Skill } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { withPrintGate } from "../print-mode.js"
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

describe("formatEnvironmentSection", () => {
	it("prints stable environment context lines", () => {
		expect(formatEnvironmentSection(testEnv)).toBe(
			[
				"## Environment",
				"",
				"- OS: Linux",
				"- OS version: #1 SMP PREEMPT_DYNAMIC Test",
				"- Raw platform: linux",
				"- CPU architecture: x64",
				"- Shell: /bin/bash",
				"- Shell family: posix",
				"- Command guidance: use commands compatible with the shell family (POSIX vs PowerShell/cmd syntax); if shell/platform conflict or are unclear, check with a read-only command before write/destructive ones.",
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

	describe("subagent mode", () => {
		it("excludes delegation tools", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
			expect(result).toContain("## Available Tools\n\nread, bash")
			expect(result).not.toContain("Agent, ")
			expect(result).not.toContain("get_subagent_result")
			expect(result).not.toContain("steer_subagent")
		})

		it("includes all other tools", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				mode: "subagent",
			})
			expect(result).toContain("## Available Tools\n\nread, bash")
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

		it("includes Working Practices section when model is provided", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",

				mode: "subagent",
			})
			expect(result).toContain("## Working Practices")
			expect(result).toContain("Prefer `edit` over `write` for files >30 lines")
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
			expect(result).not.toContain(`OS release:`)
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
		it("omits Working Practices from normal print prompts but keeps it for subagents and Ferment oneshot", async () => {
			const prompt = await withPrintGate({ print: true }, () =>
				buildSystemPrompt({
					tools,
					env: testEnv,
					currentModelId: "minimax-m3",
					mode: "single",
				}),
			)
			const subagentPrompt = await withPrintGate({ print: true }, () =>
				buildSystemPrompt({
					tools,
					env: testEnv,
					currentModelId: "minimax-m3",
					mode: "subagent",
				}),
			)

			expect(prompt).not.toContain("## Working Practices")
			expect(prompt).toContain("Always wrap shell commands with a timeout")
			expect(prompt).toContain("Never run interactive commands")
			expect(prompt).toContain("Ask before unrequested actions that publish externally")
			expect(subagentPrompt).toContain("## Working Practices")

			const fermentPrompt = await withPrintGate({ print: true, fermentOneshot: true }, () =>
				buildSystemPrompt({
					tools,
					env: testEnv,
					currentModelId: "minimax-m3",
					mode: "single",
				}),
			)
			expect(fermentPrompt).toContain("## Working Practices")
		})

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
			expect(result).toContain("## Available Tools\n\nread, bash, Agent, get_subagent_result, steer_subagent")
		})

		it("includes Working Practices section when model is provided", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",

				mode: "single",
			})
			expect(result).toContain("## Working Practices")
			expect(result).toContain("Prefer `edit` over `write` for files >30 lines")
		})

		it("retains universal safety rules without a phase tool", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",

				mode: "single",
			})
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **build** phase")
			expect(result).not.toContain("During **research** phase")
			expect(result).not.toContain("Call `set_phase`")
			// The tool-independent safety rules that used to ride the phase payload
			// are hoisted to CORE_GUIDELINES, so a --print session still sees them.
			expect(result).toContain("Co-Authored-By: Kimchi <noreply@kimchi.dev>")
			expect(result).toContain("Always wrap shell commands with a timeout")
			expect(result).toContain("Never run interactive commands")
		})

		it("keeps static working practices in subagent mode without phase instructions", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",

				mode: "subagent",
			})
			expect(result).toContain("## Working Practices")
			expect(result).not.toContain("## Phase Management")
			expect(result).not.toContain("During **build** phase")
		})

		it("includes static Working Practices for a non-OSS model", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "claude-opus-4-6-20250514",

				mode: "single",
			})
			expect(result).toContain("## Working Practices")
			expect(result).not.toContain("When researching")
			expect(result).not.toContain("version you are assuming")
			expect(result).not.toContain("version/API assumption")
			expect(result).not.toContain("do not bluff")
			expect(result).not.toContain("Do not rely on training memory")
			expect(result).not.toContain("AT MOST one")
		})

		it("includes Working Practices section for an OSS model", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",

				mode: "single",
			})
			expect(result).toContain("## Working Practices")
			// Family-specific overrides are NOT in the static Working Practices section
			expect(result).not.toContain("hallucinating APIs")
		})

		it("includes Working Practices section for an OSS model (build checks)", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",

				mode: "single",
			})
			expect(result).toContain("## Working Practices")
			expect(result).not.toContain("uncertain about a library API")
			expect(result).not.toContain("assume your knowledge may be stale")
			expect(result).not.toContain("STAY IN SCOPE")
			expect(result).not.toContain("do NOT hallucinate APIs")
		})

		it("makes subagent spawning opt-in and defaults to the current model", () => {
			const result = buildSystemPrompt({
				tools,
				env: testEnv,
				currentModelId: "minimax-m3",
				mode: "single",
			})
			// New behavior: default is to handle work directly, do not spawn subagents.
			expect(result).toContain("Handle tasks directly yourself.")
			expect(result).toContain("Do not spawn subagents")
			expect(result).toContain("only do so when the user explicitly asks for delegation")
			// When a subagent IS spawned, default to the parent's model and only
			// use a different model if the user explicitly instructs it.
			expect(result).toContain("pass your own model ID")
			expect(result).toContain("by default")
			expect(result).toContain("only use a different model if the user explicitly instructs")
			// Old autonomous-delegate phrasing must be gone.
			expect(result).not.toContain("clearly beneficial")
			expect(result).not.toContain("MUST always pass")
			expect(result).not.toContain("never delegate to a different model")
		})
	})
})
