import { describe, expect, it } from "vitest"
import { SHARED_PLANNING_PROCESS } from "../../../shared/planning/shared-planning-process.js"
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
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			activeToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls"],
		})
		expect(output).toMatchInlineSnapshot(`
			"# Environment
			Working directory: /home/testuser/projects/myapp
			Git repository: yes
			Branch: main
			Platform: linux

			<inherited_system_prompt>
			You are a kimchi coding agent. You orchestrate sub-agents and tools to solve complex tasks.
			</inherited_system_prompt>

			## Available Tools
			- read
			- bash
			- edit
			- write
			- grep
			- find
			- ls

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
			- Messages prefixed with "[Orchestrator]" are system instructions from the agent loop, not user input. Do not attribute them to the user.
			</sub_agent_context>"
		`)
	})

	it("strips inherited Available Tools and adds the subagent-local tool list", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const parentPrompt = `# Parent

## Available Tools
- Agent
- set_phase
- read

### Local Notes
Keep this h3 section.

## Rules
Keep these parent rules.`
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, parentPrompt, {
			activeToolNames: ["read", "bash"],
		})

		expect(output).toContain(
			"<inherited_system_prompt>\n# Parent\n\n### Local Notes\nKeep this h3 section.\n\n## Rules\nKeep these parent rules.\n</inherited_system_prompt>",
		)
		expect(output).toContain("## Available Tools\n- read\n- bash")
		expect(output).not.toContain("- Agent")
		expect(output).not.toContain("set_phase")
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

			# Exploration Strategy
			- **Skip explore for greenfield projects** (empty directory, no existing code). There is nothing to explore — proceed directly to plan.
			- Start broad with grep/find/ls; then read the 3-5 most relevant files in full.
			- Trace imports and call chains across module boundaries — note the actual entry points and seams, not every file you saw.
			- **Hypothesis testing**: After 5 consecutive read-only turns without a concrete hypothesis, state your hypothesis and run ONE targeted command to test it. Exploration without a hypothesis wastes tokens.
			- Stop as soon as you have enough context to plan. Over-exploring wastes tokens.

			# Tool Usage
			- For repository inspection tasks, always use at least one read-only tool before answering
			- Use the find tool for file pattern matching (NOT the bash find command)
			- Use the grep tool for content search (NOT bash grep/rg command)
			- Use the read tool for reading files (NOT bash cat/head/tail)
			- Use Bash ONLY for read-only operations
			- Make independent tool calls in parallel for efficiency
			- Adapt search approach based on thoroughness level specified

			# Output
			- A tight summary: paths, key types, integration points — what matters, not everything you saw
			- Use absolute file paths in all references
			- Do not use emojis
			- Be thorough and precise"
		`)
	})

	it("Plan agent prompt embeds the shared planning process (not duplicated inline)", () => {
		const agent = getRequired(AGENT_PLAN)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)

		// Top-level structure — these substrings lock the agent's identity and
		// the Plan-Agent-specific sections that wrap the shared process.
		expect(output).toContain("# Plan Agent — Write Access Scoped to .kimchi/plans/")
		expect(output).toContain("You are a planning specialist")
		expect(output).toContain("STRICTLY PROHIBITED")
		expect(output).toContain("# Planning Process")
		expect(output).toContain("# Tool Usage")
		expect(output).toContain("# Plan Verification Mode")
		expect(output).toContain("# Output Format")

		// Plan-Agent-specific tool bindings (override the shared planning process).
		expect(output).toContain("`questionnaire`")
		expect(output).toContain(".kimchi/plans/")

		// The shared planning process must be embedded verbatim. Asserting on the
		// imported constant means any legitimate tweak to the shared process is
		// caught by the dedicated shared-planning-process tests, not duplicated
		// here. The Reviewer noted this on PR #683.
		expect(output).toContain(SHARED_PLANNING_PROCESS)

		// Critical Files section at the end — unique to the Plan agent persona.
		expect(output).toContain("### Critical Files for Implementation")
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

			# Research Strategy
			- Run AT MOST one web_search per task. Do not re-search to "verify" — pick the best query the first time.
			- Skip web research for well-known patterns, standard algorithms, or common library APIs you already know.
			- Search broadly, then narrow to the most authoritative sources.
			- Prefer official docs and primary sources (official docs, GitHub READMEs, RFCs) over forum posts. Avoid web_fetch unless the page is unindexed or the user gave a specific URL.
			- Cross-reference multiple sources before concluding.
			- Always cite sources (URL or file path with line range).
			- If research output is non-trivial (more than one fact), save a short markdown note to the Documents directory and reference it from the next phase.
			- Stay read-only; never modify files.

			Deliver a structured report: summary first, then supporting evidence with citations."
		`)
	})
})

describe("contextFiles injection", () => {
	it("includes ## Project Guidelines block when contextFiles are provided", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			contextFiles: [{ path: "/home/testuser/AGENTS.md", content: "# My Project\nSome guidelines." }],
		})
		expect(output).toContain("## Project Guidelines")
		expect(output).toContain("Some guidelines.")
	})

	it("shifts top-level headings down one level in context file content", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			contextFiles: [{ path: "/repo/AGENTS.md", content: "# Top\n## Second\n### Third" }],
		})
		// # Top → ## Top, ## Second → ### Second, ### Third → #### Third
		expect(output).toContain("## Top")
		expect(output).toContain("### Second")
		expect(output).toContain("#### Third")
		expect(output).not.toMatch(/^# Top/m)
	})

	it("concatenates multiple context files separated by a blank line", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			contextFiles: [
				{ path: "/AGENTS.md", content: "Root guidelines." },
				{ path: "/home/testuser/projects/myapp/AGENTS.md", content: "Project guidelines." },
			],
		})
		expect(output).toContain("Root guidelines.")
		expect(output).toContain("Project guidelines.")
	})

	it("does not include ## Project Guidelines block when contextFiles is empty", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			contextFiles: [],
		})
		expect(output).not.toContain("## Project Guidelines")
	})

	it("does not include ## Project Guidelines block when contextFiles is absent", () => {
		const agent = getRequired(AGENT_GENERAL_PURPOSE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
		expect(output).not.toContain("## Project Guidelines")
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
