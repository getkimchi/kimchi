import { describe, expect, it } from "vitest"

import { DEFAULT_AGENTS } from "./default-agents.js"
import { AGENT_BUILDER, AGENT_EXPLORE, AGENT_GENERAL_PURPOSE, AGENT_PLAN, AGENT_RESEARCHER } from "./types.js"

import { resolveAgentInvocationConfig } from "../resolution/invocation-config.js"

describe("DEFAULT_AGENTS", () => {
	it("always includes General-Purpose, Explore, Plan, and Researcher agents", () => {
		expect(DEFAULT_AGENTS.has(AGENT_GENERAL_PURPOSE)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_EXPLORE)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_PLAN)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_RESEARCHER)).toBe(true)
	})

	it("default personas do not declare models", () => {
		for (const agent of DEFAULT_AGENTS.values()) {
			expect(agent.models).toBeUndefined()
		}
	})

	it("all default agents are marked isDefault", () => {
		for (const agent of DEFAULT_AGENTS.values()) {
			expect(agent.isDefault).toBe(true)
		}
	})

	it("Plan agent includes write and edit in builtinToolNames", () => {
		const plan = DEFAULT_AGENTS.get(AGENT_PLAN) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(plan.builtinToolNames).toContain("write")
		expect(plan.builtinToolNames).toContain("edit")
	})

	it("Plan agent has roles set to plan", () => {
		const plan = DEFAULT_AGENTS.get(AGENT_PLAN) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(plan.roles).toContain("plan")
	})

	it("Plan agent has includeContextFiles set to true", () => {
		const plan = DEFAULT_AGENTS.get(AGENT_PLAN) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(plan.includeContextFiles).toBe(true)
	})

	it("Explore agent has roles set to explore", () => {
		const explore = DEFAULT_AGENTS.get(AGENT_EXPLORE) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(explore.roles).toContain("explore")
	})

	it("Explore agent asks for a narrower follow-up when prompts are underspecified", () => {
		const explore = DEFAULT_AGENTS.get(AGENT_EXPLORE) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(explore.systemPrompt).toContain(
			"do one cheap search, read only the most relevant starting points, then stop and ask the orchestrator for a narrower follow-up",
		)
		expect(explore.systemPrompt).toContain("Start from the exact files/directories named by the orchestrator")
		expect(explore.systemPrompt).toContain("Stop when the prompt's stop condition is met")
		expect(explore.systemPrompt).toContain("State where you stopped and why")
		expect(explore.systemPrompt).not.toContain("3-5 most relevant files")
	})

	it("Researcher agent has roles set to research", () => {
		const r = DEFAULT_AGENTS.get(AGENT_RESEARCHER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(r.roles).toContain("research")
	})

	it("Builder prompt instructs trust in provided context and limits verification turns", () => {
		const builder = DEFAULT_AGENTS.get(AGENT_BUILDER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(builder.systemPrompt).toContain(
			"Treat the provided file paths, code snippets, and task description as authoritative",
		)
		expect(builder.systemPrompt).toContain(
			"Do not spend more than **2 consecutive turns** reading or verifying before making the first concrete edit",
		)
		expect(builder.systemPrompt).toContain("Do not re-read files merely to confirm what was provided")
	})
})

describe("default agents — resolved invocation config snapshot", () => {
	const cases: Record<string, string> = {
		"General-Purpose": AGENT_GENERAL_PURPOSE,
		Explore: AGENT_EXPLORE,
		Plan: AGENT_PLAN,
		Researcher: AGENT_RESEARCHER,
	}

	for (const [label, key] of Object.entries(cases)) {
		it(label, () => {
			const agent = DEFAULT_AGENTS.get(key)
			if (!agent) throw new Error(`expected default agent '${label}' to exist`)
			const resolved = resolveAgentInvocationConfig(agent, {})
			expect({
				name: agent.name,
				modelId: resolved.modelInput,
				thinking: resolved.thinking,
				maxTurns: resolved.maxTurns,
				tokenBudget: resolved.tokenBudget,
				roles: agent.roles,
				builtinToolNames: agent.builtinToolNames,
			}).toMatchSnapshot()
		})
	}
})
