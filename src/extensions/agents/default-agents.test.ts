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
})
