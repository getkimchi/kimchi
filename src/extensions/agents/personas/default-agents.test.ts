import { describe, expect, it, vi } from "vitest"

// Mock getEffectiveModelRoles BEFORE default-agents.ts is imported so buildDefaultAgents()
// uses deterministic defaults instead of reading ~/.config/kimchi/harness/settings.json.
vi.mock("../../model-registry/model-roles.js", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		getEffectiveModelRoles: vi.fn().mockReturnValue(actual.DEFAULT_MODEL_ROLES),
	}
})

import { DEFAULT_AGENTS, SUBAGENT_BASE_PROMPT } from "./default-agents.js"
import { AGENT_BUILDER, AGENT_EXPLORE, AGENT_PLAN, AGENT_RESEARCHER, AGENT_REVIEWER } from "./types.js"

// Stub pickFromModelListByTier and recommendModel so snapshots are deterministic.
vi.mock("../../model-registry/recommend.js", () => ({
	recommendModel: vi.fn().mockReturnValue(undefined),
	pickFromModelListByTier: vi.fn().mockImplementation((list: readonly string[], preferTier?: string) => {
		if (preferTier === "heavy") {
			return (
				list.find((model) => model.includes("kimi-k2.6")) ??
				list.find((model) => model.includes("claude-opus")) ??
				list[0]
			)
		}
		return list[0]
	}),
}))

vi.mock("../../tags.js", () => ({
	getCurrentPhase: vi.fn().mockReturnValue(undefined),
}))

import { resolveAgentInvocationConfig } from "../resolution/invocation-config.js"

describe("DEFAULT_AGENTS", () => {
	it("includes Builder, Reviewer, Explore, Plan, and Researcher agents", () => {
		expect(DEFAULT_AGENTS.has(AGENT_BUILDER)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_REVIEWER)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_EXPLORE)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_PLAN)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_RESEARCHER)).toBe(true)
	})

	it("does not include General-Purpose", () => {
		expect(DEFAULT_AGENTS.has("General-Purpose")).toBe(false)
	})

	it("Builder agent uses a kimchi-dev model", () => {
		const b = DEFAULT_AGENTS.get(AGENT_BUILDER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(b.models?.[0]).toMatch(/^kimchi-dev\//)
	})

	it("Reviewer agent uses a kimchi-dev model", () => {
		const r = DEFAULT_AGENTS.get(AGENT_REVIEWER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(r.models?.[0]).toMatch(/^kimchi-dev\//)
	})

	it("Explore agent uses a kimchi-dev model", () => {
		const explore = DEFAULT_AGENTS.get(AGENT_EXPLORE) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(explore.models?.[0]).toMatch(/^kimchi-dev\//)
	})

	it("Plan agent uses a kimchi-dev model", () => {
		const plan = DEFAULT_AGENTS.get(AGENT_PLAN) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(plan.models?.[0]).toMatch(/^kimchi-dev\//)
	})

	it("Researcher agent uses a kimchi-dev model", () => {
		const r = DEFAULT_AGENTS.get(AGENT_RESEARCHER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(r.models?.[0]).toMatch(/^kimchi-dev\//)
	})

	it("every persona's systemPrompt starts with SUBAGENT_BASE_PROMPT content", () => {
		const sentinel = "You are Kimchi, an AI coding agent"
		for (const [name, agent] of DEFAULT_AGENTS) {
			expect(agent.systemPrompt, `${name} systemPrompt should start with base`).toContain(sentinel)
		}
	})

	it("every persona's systemPrompt contains SUBAGENT_RESPONSE_PROTOCOL", () => {
		for (const [name, agent] of DEFAULT_AGENTS) {
			expect(agent.systemPrompt, `${name} should contain response protocol`).toContain("Subagent response protocol")
			expect(agent.systemPrompt, `${name} should contain JSON shape`).toContain('"summary"')
		}
	})

	it("Researcher has includeContextFiles false", () => {
		const r = DEFAULT_AGENTS.get(AGENT_RESEARCHER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(r.includeContextFiles).toBe(false)
	})

	it("Builder and Reviewer have includeContextFiles true", () => {
		const b = DEFAULT_AGENTS.get(AGENT_BUILDER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		const r = DEFAULT_AGENTS.get(AGENT_REVIEWER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(b.includeContextFiles).toBe(true)
		expect(r.includeContextFiles).toBe(true)
	})

	it("Researcher has skills false", () => {
		const r = DEFAULT_AGENTS.get(AGENT_RESEARCHER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(r.skills).toBe(false)
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

	it("SUBAGENT_BASE_PROMPT is exported and contains expected sections", () => {
		expect(SUBAGENT_BASE_PROMPT).toContain("You are Kimchi")
		expect(SUBAGENT_BASE_PROMPT).toContain("Documents")
		expect(SUBAGENT_BASE_PROMPT).toContain("Guidelines")
		expect(SUBAGENT_BASE_PROMPT).toContain("Factual Accuracy")
		expect(SUBAGENT_BASE_PROMPT).toContain("Subagent response protocol")
	})
})

describe("default agents — resolved invocation config snapshot", () => {
	it("Builder", () => {
		const agent = DEFAULT_AGENTS.get(AGENT_BUILDER)
		if (!agent) throw new Error("expected default agent 'Builder' to exist")
		const resolved = resolveAgentInvocationConfig(agent, {})
		expect({
			name: agent.name,
			modelId: resolved.modelInput,
			modelLocked: agent.modelLocked,
			thinking: resolved.thinking,
			maxTurns: resolved.maxTurns,
			tokenBudget: resolved.tokenBudget,
			preferTier: agent.preferTier,
			strengths: agent.strengths,
			builtinToolNames: agent.builtinToolNames,
		}).toMatchSnapshot()
	})

	it("Reviewer", () => {
		const agent = DEFAULT_AGENTS.get(AGENT_REVIEWER)
		if (!agent) throw new Error("expected default agent 'Reviewer' to exist")
		const resolved = resolveAgentInvocationConfig(agent, {})
		expect({
			name: agent.name,
			modelId: resolved.modelInput,
			modelLocked: agent.modelLocked,
			thinking: resolved.thinking,
			maxTurns: resolved.maxTurns,
			tokenBudget: resolved.tokenBudget,
			preferTier: agent.preferTier,
			strengths: agent.strengths,
			builtinToolNames: agent.builtinToolNames,
		}).toMatchSnapshot()
	})

	it("Explore", () => {
		const agent = DEFAULT_AGENTS.get(AGENT_EXPLORE)
		if (!agent) throw new Error("expected default agent 'Explore' to exist")
		const resolved = resolveAgentInvocationConfig(agent, {})
		expect({
			name: agent.name,
			modelId: resolved.modelInput,
			modelLocked: agent.modelLocked,
			thinking: resolved.thinking,
			maxTurns: resolved.maxTurns,
			tokenBudget: resolved.tokenBudget,
			preferTier: agent.preferTier,
			strengths: agent.strengths,
			builtinToolNames: agent.builtinToolNames,
		}).toMatchSnapshot()
	})

	it("Plan", () => {
		const agent = DEFAULT_AGENTS.get(AGENT_PLAN)
		if (!agent) throw new Error("expected default agent 'Plan' to exist")
		const resolved = resolveAgentInvocationConfig(agent, {})
		expect({
			name: agent.name,
			modelId: resolved.modelInput,
			modelLocked: agent.modelLocked,
			thinking: resolved.thinking,
			maxTurns: resolved.maxTurns,
			tokenBudget: resolved.tokenBudget,
			preferTier: agent.preferTier,
			strengths: agent.strengths,
			builtinToolNames: agent.builtinToolNames,
		}).toMatchSnapshot()
	})

	it("Researcher", () => {
		const agent = DEFAULT_AGENTS.get(AGENT_RESEARCHER)
		if (!agent) throw new Error("expected default agent 'Researcher' to exist")
		const resolved = resolveAgentInvocationConfig(agent, {})
		expect({
			name: agent.name,
			modelId: resolved.modelInput,
			modelLocked: agent.modelLocked,
			thinking: resolved.thinking,
			maxTurns: resolved.maxTurns,
			tokenBudget: resolved.tokenBudget,
			preferTier: agent.preferTier,
			strengths: agent.strengths,
			builtinToolNames: agent.builtinToolNames,
		}).toMatchSnapshot()
	})
})
