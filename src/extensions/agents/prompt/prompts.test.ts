import { describe, expect, it } from "vitest"
import { DEFAULT_AGENTS } from "../personas/default-agents.js"
import { AGENT_BUILDER, AGENT_EXPLORE, AGENT_PLAN, AGENT_RESEARCHER, type EnvInfo } from "../personas/types.js"
import type { AgentConfig } from "../personas/types.js"
import { buildAgentPrompt, formatTokenBudget } from "./prompts.js"

const FIXED_ENV: EnvInfo = {
	isGitRepo: true,
	branch: "main",
	platform: "linux",
}

const FIXED_CWD = "/home/testuser/projects/myapp"

const PARENT_SYSTEM_PROMPT =
	"You are a kimchi coding agent. You orchestrate sub-agents and tools to solve complex tasks."

/** A minimal append-mode agent for testing prompt assembly mechanics. */
const APPEND_AGENT: AgentConfig = {
	name: "test-append",
	description: "test",
	extensions: true,
	skills: false,
	systemPrompt: "",
	promptMode: "append",
}

function getRequired(name: string): ReturnType<typeof DEFAULT_AGENTS.get> & object {
	const a = DEFAULT_AGENTS.get(name)
	if (!a) throw new Error(`expected default agent '${name}' to exist`)
	return a
}

describe("default agents — subagent system prompt snapshot", () => {
	it("Builder agent assembles expected prompt (replace mode)", () => {
		const agent = getRequired(AGENT_BUILDER)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
		expect(output).toContain("You are Kimchi, an AI coding agent")
		expect(output).toContain("Subagent response protocol")
		expect(output).toContain("Builder Guidelines")
		expect(output).toContain("During **build** phase")
	})

	it("Explore agent assembles expected prompt (replace mode)", () => {
		const agent = getRequired(AGENT_EXPLORE)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
		expect(output).toContain("You are Kimchi, an AI coding agent")
		expect(output).toContain("READ-ONLY MODE")
		expect(output).toContain("Explorer Guidelines")
	})

	it("Plan agent assembles expected prompt (replace mode)", () => {
		const agent = getRequired(AGENT_PLAN)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
		expect(output).toContain("You are Kimchi, an AI coding agent")
		expect(output).toContain("Plan Agent")
		expect(output).toContain(".kimchi/plans/")
	})

	it("Researcher agent assembles expected prompt (replace mode)", () => {
		const agent = getRequired(AGENT_RESEARCHER)
		const output = buildAgentPrompt(agent, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
		expect(output).toContain("You are Kimchi, an AI coding agent")
		expect(output).toContain("research specialist")
	})

	it("append mode assembles env + parent + bridge", () => {
		const output = buildAgentPrompt(APPEND_AGENT, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
		expect(output).toContain("inherited_system_prompt")
		expect(output).toContain(PARENT_SYSTEM_PROMPT)
		expect(output).toContain("sub_agent_context")
	})
})

describe("contextFiles injection", () => {
	it("includes ## Project Guidelines block when contextFiles are provided", () => {
		const output = buildAgentPrompt(APPEND_AGENT, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			contextFiles: [{ path: "/home/testuser/AGENTS.md", content: "# My Project\nSome guidelines." }],
		})
		expect(output).toContain("## Project Guidelines")
		expect(output).toContain("Some guidelines.")
	})

	it("shifts top-level headings down one level in context file content", () => {
		const output = buildAgentPrompt(APPEND_AGENT, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			contextFiles: [{ path: "/repo/AGENTS.md", content: "# Top\n## Second\n### Third" }],
		})
		expect(output).toContain("## Top")
		expect(output).toContain("### Second")
		expect(output).toContain("#### Third")
		expect(output).not.toMatch(/^# Top/m)
	})

	it("concatenates multiple context files separated by a blank line", () => {
		const output = buildAgentPrompt(APPEND_AGENT, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			contextFiles: [
				{ path: "/AGENTS.md", content: "Root guidelines." },
				{ path: "/home/testuser/projects/myapp/AGENTS.md", content: "Project guidelines." },
			],
		})
		expect(output).toContain("Root guidelines.")
		expect(output).toContain("Project guidelines.")
	})

	it("does not include ## Project Guidelines block when contextFiles is empty", () => {
		const output = buildAgentPrompt(APPEND_AGENT, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			contextFiles: [],
		})
		expect(output).not.toContain("## Project Guidelines")
	})

	it("does not include ## Project Guidelines block when contextFiles is absent", () => {
		const output = buildAgentPrompt(APPEND_AGENT, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT)
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
		const output = buildAgentPrompt(APPEND_AGENT, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			budget: { maxTurns: 30 },
		})
		expect(output).toContain("<budget>")
		expect(output).toContain("Turn limit: 30 turns")
		expect(output).not.toContain("Output token budget")
	})

	it("includes both turn and token budget when both are provided", () => {
		const output = buildAgentPrompt(APPEND_AGENT, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			budget: { maxTurns: 30, tokenBudget: 200_000 },
		})
		expect(output).toContain("Turn limit: 30 turns")
		expect(output).toContain("Output token budget: ~200k")
	})

	it("includes only token budget when maxTurns is not set", () => {
		const output = buildAgentPrompt(APPEND_AGENT, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
			budget: { tokenBudget: 1_500_000 },
		})
		expect(output).toContain("Output token budget: ~1.5M")
		expect(output).not.toContain("Turn limit")
	})

	it("does not include budget section when budget is empty", () => {
		const output = buildAgentPrompt(APPEND_AGENT, FIXED_CWD, FIXED_ENV, PARENT_SYSTEM_PROMPT, {
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
