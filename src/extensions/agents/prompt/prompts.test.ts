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
			You are a planning specialist. Your role is to understand requirements, ask clarifying questions, and design clear plans.

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

			1. **Decide whether to explore first.** Only read files if the task is about code or software. If the task is NOT about code (writing, strategy, general planning), skip exploration entirely and go straight to clarifying questions.
			2. **Draft the plan directly.** Do NOT use any workflow-starting mechanism.
			3. Understand requirements — ask clarifying questions via \`questionnaire\` before committing to an approach.
			4. If code-related: explore relevant files, understand architecture, identify patterns.
			5. Identify ambiguities and resolve them with the user before proceeding.
			6. Design a solution and write the plan.
			7. Verify there are no unresolved assumptions before finalising.

			# Requirements
			- Consider trade-offs and decisions
			- Identify dependencies and sequencing
			- Anticipate potential challenges
			- Follow existing patterns where appropriate

			# Tool Usage
			- Use the find tool for file pattern matching (NOT the bash find command)
			- Use the grep tool for content search (NOT bash grep/rg command)
			- Use the read tool for reading files (NOT bash cat/head/tail)
			- Use Bash ONLY for read-only operations
			- Use \`questionnaire\` when you encounter ambiguity — do not leave it implicit
			- Use write only to create/update \`.kimchi/plans/*.md\` files
			- Use edit only to modify \`.kimchi/plans/*.md\` files

			# Plan Format
			Use this structure in every plan file:

			## Goal
			One-sentence statement of what the plan achieves.

			## Constraints
			Non-negotiable requirements (e.g., no new dependencies, preserve existing API).

			## Chunks
			Ordered, independently-verifiable units of work. Each chunk has:
			- **Scope**: what it covers (file paths, components)
			- **Depends On**: prior chunk(s) required
			- **Accept When**: 2-3 concrete, verifiable criteria
			- **Open Questions**: explicitly list unknowns or assumptions — never leave implicit

			## Verification Strategy
			How to confirm each chunk is correct (test command, manual check, etc.).

			## Decision Log
			Tracked choices with rationale; rejected alternatives noted.

			## Risks
			Named risks with likelihood and mitigation.

			# Question Rule

			**Ask clarifying questions before committing to a plan.** If the request omits information you need to choose a technology, bound the scope, or set performance targets, use the \`questionnaire\` tool. Ask 1–3 focused questions. Prefer multi questions when multiple options apply; single for one choice. Do not ask preference-survey questions when a safe default is obvious.

			# Finalization Rule

			**Do not present the plan as complete and ready for approval while any Open Question remains unresolved.** You may present *draft* plans with explicit assumptions listed, but before finalizing you must use the \`questionnaire\` tool to resolve each assumption with the user.

			When your plan is complete, finished, and ready for user approval, end your response with one of these markers on its own line:

			<!-- PLAN_COMPLETE -->

			or simply:

			<done>

			Either marker signals the system to show the approval menu. Do NOT include them on incomplete drafts, while assumptions remain unresolved, or when asking clarifying questions.

			# Plan Verification Mode

			When asked to verify a plan: read the plan and task description, check completeness (chunks ordered, interfaces defined, acceptance criteria verifiable, edge cases addressed), flag chunks marked \`simple\` that contain concurrency or complex algorithms as misclassified. Output **APPROVED** or **NEEDS_REVISION** with specific gaps. Do NOT rewrite the plan.

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
