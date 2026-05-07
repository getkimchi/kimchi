import { describe, expect, it } from "vitest"
import { DEFAULT_AGENTS } from "./default-agents.js"

describe("DEFAULT_AGENTS", () => {
	it("always includes general-purpose, Explore, and Plan agents", () => {
		expect(DEFAULT_AGENTS.has("general-purpose")).toBe(true)
		expect(DEFAULT_AGENTS.has("Explore")).toBe(true)
		expect(DEFAULT_AGENTS.has("Plan")).toBe(true)
	})

	it("Explore agent uses a kimchi-dev model", () => {
		const explore = DEFAULT_AGENTS.get("Explore") as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(explore.model).toMatch(/^kimchi-dev\//)
	})

	it("Plan agent uses a kimchi-dev model", () => {
		const plan = DEFAULT_AGENTS.get("Plan") as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(plan.model).toMatch(/^kimchi-dev\//)
	})

	it("general-purpose agent has no model (inherits parent)", () => {
		const gp = DEFAULT_AGENTS.get("general-purpose") as NonNullable<ReturnType<typeof DEFAULT_AGENTS.get>>
		expect(gp.model).toBeUndefined()
	})

	it("all default agents are marked isDefault", () => {
		for (const agent of DEFAULT_AGENTS.values()) {
			expect(agent.isDefault).toBe(true)
		}
	})
})
