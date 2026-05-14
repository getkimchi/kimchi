import { describe, expect, it, vi } from "vitest"
import { DEFAULT_AGENTS } from "./default-agents.js"
import { AGENT_EXPLORE, AGENT_GENERAL_PURPOSE, AGENT_PLAN, AGENT_RESEARCHER } from "./types.js"

// ---------------------------------------------------------------------------
// Snapshot suite — resolved invocation config for every default agent
// ---------------------------------------------------------------------------

// Stub pickFromModelListByTier and recommendModel so snapshots are deterministic
// and don't depend on the live model registry insertion order.
// We cannot import the real implementations here because default-agents.ts calls
// modelsForStrength/modelsForAnyStrength at module load time (before any mock can
// intercept), so DEFAULT_AGENTS.models[] is already populated with real strings.
// We therefore stub only the functions called at resolve-time:
//   - pickFromModelListByTier (used when models[] is populated — all 4 default agents)
//   - recommendModel          (only reachable when models[] is absent — never for defaults)
//   - getCurrentPhase         (only reachable when both models[] and strengths are absent)
// Because all four default agents have models[] pre-populated, pickFromModelListByTier
// is the only stub that actually fires.  We pin it to return the first entry of the
// list so the snapshot reflects the tier-unaware stable default.
vi.mock("../../orchestration/model-registry/recommend.js", () => ({
	recommendModel: vi.fn().mockReturnValue(undefined),
	pickFromModelListByTier: vi.fn().mockImplementation((list: readonly string[]) => list[0]),
}))

vi.mock("../../tags.js", () => ({
	getCurrentPhase: vi.fn().mockReturnValue(undefined),
}))

import { resolveAgentInvocationConfig } from "../resolution/invocation-config.js"

describe("DEFAULT_AGENTS", () => {
	it("always includes General-Purpose, Explore, Plan, and Researcher agents", () => {
		expect(DEFAULT_AGENTS.has(AGENT_GENERAL_PURPOSE)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_EXPLORE)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_PLAN)).toBe(true)
		expect(DEFAULT_AGENTS.has(AGENT_RESEARCHER)).toBe(true)
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

	it("General-Purpose agent declares a models[] array", () => {
		const gp = DEFAULT_AGENTS.get(AGENT_GENERAL_PURPOSE) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(gp.models?.length).toBeGreaterThan(0)
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

	it("Plan agent has strengths set to plan", () => {
		const plan = DEFAULT_AGENTS.get(AGENT_PLAN) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(plan.strengths).toContain("plan")
	})

	it("Explore agent has strengths set to explore", () => {
		const explore = DEFAULT_AGENTS.get(AGENT_EXPLORE) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(explore.strengths).toContain("explore")
	})

	it("Researcher agent has strengths set to research", () => {
		const r = DEFAULT_AGENTS.get(AGENT_RESEARCHER) as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(r.strengths).toContain("research")
	})
})

describe("default agents — resolved invocation config snapshot", () => {
	// NOTE: modelId is included in the snapshot. pickFromModelListByTier is stubbed
	// to return list[0] (registry insertion order), so the value is stable across
	// test runs but will change if the models[] array on a default agent changes —
	// which is exactly when we want the snapshot to break.
	it("General-Purpose", () => {
		const agent = DEFAULT_AGENTS.get(AGENT_GENERAL_PURPOSE)
		if (!agent) throw new Error("expected default agent 'General-Purpose' to exist")
		const resolved = resolveAgentInvocationConfig(agent, {})
		expect({
			name: agent.name,
			modelId: resolved.modelInput,
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
			thinking: resolved.thinking,
			maxTurns: resolved.maxTurns,
			tokenBudget: resolved.tokenBudget,
			preferTier: agent.preferTier,
			strengths: agent.strengths,
			builtinToolNames: agent.builtinToolNames,
		}).toMatchSnapshot()
	})
})
