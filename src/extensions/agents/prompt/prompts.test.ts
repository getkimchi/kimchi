import { describe, expect, it } from "vitest"
import { DEFAULT_AGENTS } from "../personas/default-agents.js"
import { AGENT_EXPLORE, AGENT_GENERAL_PURPOSE, AGENT_PLAN, AGENT_RESEARCHER, type EnvInfo } from "../personas/types.js"
import { buildAgentPrompt, formatTokenBudget } from "./prompts.js"

const FIXED_ENV: EnvInfo = {
	isGitRepo: true,
	branch: "main",
	platform: "linux",
}

const FIXED_CWD = "/home/testuser/projects/myapp"

const PARENT_SYSTEM_PROMPT =
	"You are a kimchi coding agent. You orchestrate sub-agents and tools to solve complex tasks."

function getRequired(name: string): ReturnType<typeof DEFAULT_AGENTS.get> & object {
	const a = DEFAULT_AGENTS.get(name)
	if (!a) throw new Error(`expected default agent '${name}' to exist`)
	return a
}

describe("default agents — subagent system prompt snapshot", () => {
	it("General-Purpose agent assembles expected prompt (append mode)", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
		expect(output).toMatchInlineSnapshot(`
			"# Environment
			Working directory: /home/testuser/projects/myapp
			Git repository: yes
			Branch: main
			Platform: linux

			<inherited_system_prompt>
			You are a kimchi coding agent. You orchestrate sub-agents and tools to solve complex tasks.
			</inherited_system_prompt>

			<sub_agent_context>
			You are operating as a sub-agent invoked to handle a specific task.
			- Use the read tool instead of cat/head/tail
			- Use the edit tool instead of sed/awk
			- Use the write tool instead of echo/heredoc
			- Use the find tool instead of bash find/ls for file search
			- Use the grep tool instead of bash grep/rg for content search
			- Make independent tool calls in parallel
			- Use absolute file paths
			- Do not use emojis
			- Be concise but complete
			</sub_agent_context>"
		`)
	})

	it("Explore agent assembles expected prompt (replace mode)", () => {
		const agent = getRequired(AGENT_EXPLORE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
		expect(output).toMatchInlineSnapshot(`
			"You are a kimchi coding agent sub-agent.
			You have been invoked to handle a specific task autonomously.

			# Environment
			Working directory: /home/testuser/projects/myapp
			Git repository: yes
			Branch: main
			Platform: linux

			# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
			You are a file search specialist. You excel at thoroughly navigating and exploring files/directories.
			Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools.

			You are STRICTLY PROHIBITED from:
			- Creating new files
			- Modifying existing files
			- Deleting files
			- Moving or copying files
			- Creating temporary files anywhere, including /tmp
			- Using redirect operators (>, >>, |) or heredocs to write to files
			- Running ANY commands that change system state

			Use Bash ONLY for read-only operations: ls, git status, git log, git diff, find, cat, head, tail.

			# Tool Usage
			- For repository inspection tasks, always use at least one read-only tool before answering
			- Use the find tool for file pattern matching (NOT the bash find command)
			- Use the grep tool for content search (NOT bash grep/rg command)
			- Use the read tool for reading files (NOT bash cat/head/tail)
			- Use Bash ONLY for read-only operations
			- Make independent tool calls in parallel for efficiency
			- Adapt search approach based on thoroughness level specified

			# Output
			- Use absolute file paths in all references
			- Report findings as regular messages
			- Do not use emojis
			- Be thorough and precise"
		`)
	})

	it("Plan agent assembles expected prompt (replace mode)", () => {
		const agent = getRequired(AGENT_PLAN)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
		expect(output).toMatchInlineSnapshot(`
			"You are a kimchi coding agent sub-agent.
			You have been invoked to handle a specific task autonomously.

			# Environment
			Working directory: /home/testuser/projects/myapp
			Git repository: yes
			Branch: main
			Platform: linux

			# Plan Agent — Write Access Scoped to .kimchi/plans/
			You are a software architect and planning specialist.
			Your role is to explore the codebase and design implementation plans, capturing them as plan files.

			You may create and update plan files under \`.kimchi/plans/\`. Do NOT modify any other files.
			Use the \`write\` tool only for plan files (paths starting with \`.kimchi/plans/\`); use \`read\`, \`grep\`, \`find\`, \`ls\` for everything else.

			You are STRICTLY PROHIBITED from:
			- Creating or modifying files outside of \`.kimchi/plans/\`
			- Deleting files
			- Moving or copying files
			- Creating temporary files anywhere, including /tmp
			- Using redirect operators (>, >>, |) or heredocs to write to files
			- Running ANY commands that change system state

			# Planning Process
			1. Understand requirements
			2. Explore thoroughly (read files, find patterns, understand architecture)
			3. Design solution based on your assigned perspective
			4. Write the plan to \`.kimchi/plans/<name>.md\` using the write tool
			5. Detail the plan with step-by-step implementation strategy

			# Requirements
			- Consider trade-offs and architectural decisions
			- Identify dependencies and sequencing
			- Anticipate potential challenges
			- Follow existing patterns where appropriate

			# Tool Usage
			- Use the find tool for file pattern matching (NOT the bash find command)
			- Use the grep tool for content search (NOT bash grep/rg command)
			- Use the read tool for reading files (NOT bash cat/head/tail)
			- Use Bash ONLY for read-only operations
			- Use write only to create/update \`.kimchi/plans/*.md\` files
			- Use edit only to modify \`.kimchi/plans/*.md\` files

			# Output Format
			- Use absolute file paths
			- Do not use emojis
			- Write your plan to \`.kimchi/plans/<descriptive-name>.md\`
			- End your response with:

			### Critical Files for Implementation
			List 3-5 files most critical for implementing this plan:
			- /absolute/path/to/file.ts - [Brief reason]"
		`)
	})

	it("Researcher agent assembles expected prompt (replace mode)", () => {
		const agent = getRequired(AGENT_RESEARCHER)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
		expect(output).toMatchInlineSnapshot(`
			"You are a kimchi coding agent sub-agent.
			You have been invoked to handle a specific task autonomously.

			# Environment
			Working directory: /home/testuser/projects/myapp
			Git repository: yes
			Branch: main
			Platform: linux

			You are a research specialist. Your job is to find accurate, well-sourced answers from the web, documentation, and the local codebase.

			Focus areas:
			- Search broadly, then narrow to the most authoritative sources
			- Always cite sources (URL or file path with line range)
			- Prefer official docs and primary sources over forum posts
			- Cross-reference multiple sources before concluding
			- Stay read-only; never modify files

			Deliver a structured report: summary first, then supporting evidence with citations."
		`)
	})
})

describe("formatTokenBudget", () => {
	const cases: Record<string, { input: number; expected: string }> = {
		"formats millions": { input: 1_500_000, expected: "1.5M" },
		"formats thousands": { input: 200_000, expected: "200k" },
		"formats small numbers as-is": { input: 500, expected: "500" },
		"formats exact million": { input: 1_000_000, expected: "1.0M" },
		"formats exact thousand": { input: 1_000, expected: "1k" },
	}

	for (const [name, tc] of Object.entries(cases)) {
		it(name, () => {
			expect(formatTokenBudget(tc.input)).toBe(tc.expected)
		})
	}
})

describe("budget block in system prompt", () => {
	it("includes budget section when maxTurns is provided", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			budget: { maxTurns: 30 },
		})
		expect(output).toContain("<budget>")
		expect(output).toContain("Turn limit: 30 turns")
		expect(output).not.toContain("Output token budget")
	})

	it("includes both turn and token budget when both are provided", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			budget: { maxTurns: 30, tokenBudget: 200_000 },
		})
		expect(output).toContain("Turn limit: 30 turns")
		expect(output).toContain("Output token budget: ~200k")
	})

	it("includes only token budget when maxTurns is not set", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			budget: { tokenBudget: 1_500_000 },
		})
		expect(output).toContain("Output token budget: ~1.5M")
		expect(output).not.toContain("Turn limit")
	})

	it("does not include budget section when budget is empty", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			budget: {},
		})
		expect(output).not.toContain("<budget>")
	})

	it("includes budget section in replace mode too", () => {
		const agent = getRequired(AGENT_EXPLORE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			budget: { maxTurns: 15, tokenBudget: 100_000 },
		})
		expect(output).toContain("<budget>")
		expect(output).toContain("Turn limit: 15 turns")
		expect(output).toContain("Output token budget: ~100k")
	})
})
