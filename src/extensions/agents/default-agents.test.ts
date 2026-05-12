import { describe, expect, it } from "vitest"
import { DEFAULT_AGENTS } from "./personas/default-agents.js"
import { AGENT_EXPLORE, AGENT_GENERAL_PURPOSE, AGENT_PLAN, AGENT_RESEARCHER } from "./personas/types.js"

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
})
