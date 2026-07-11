import { describe, expect, it } from "vitest"

// Test that the Grader agent type is registered and has the correct config.
describe("Grader agent registration", () => {
	it("Grader is in the default agent registry with correct config", async () => {
		const { getAgentConfig, resolveType, registerAgents } = await import("../../agents/personas/agent-types.js")
		// Register default agents into the lookup maps
		registerAgents(new Map())
		expect(resolveType("Grader")).toBe("Grader")
		expect(resolveType("grader")).toBe("Grader") // case-insensitive

		const cfg = getAgentConfig("Grader")
		expect(cfg).toBeDefined()
		if (!cfg) return

		// Must be read-only + bash only — no edit, write, or Agent
		expect(cfg.builtinToolNames).toContain("bash")
		expect(cfg.builtinToolNames).toContain("read")
		expect(cfg.builtinToolNames).toContain("grep")
		expect(cfg.builtinToolNames).toContain("find")
		expect(cfg.builtinToolNames).toContain("ls")
		expect(cfg.disallowedTools).toContain("edit")
		expect(cfg.disallowedTools).toContain("write")
		expect(cfg.disallowedTools).toContain("Agent")

		// Must be bounded
		expect(cfg.maxTurns).toBe(10)
		expect(cfg.tokenBudget).toBe(50_000)
		expect(cfg.maxDuration).toBe(120)

		// No extensions or skills — purely built-in tools
		expect(cfg.extensions).toBe(false)
		expect(cfg.skills).toBe(false)

		// System prompt must contain the council-of-specialists rubric
		expect(cfg.systemPrompt).toContain("PESSIMISTIC")
		expect(cfg.systemPrompt).toContain("Security attacker")
		expect(cfg.systemPrompt).toContain("Code quality review")
		expect(cfg.systemPrompt).toContain("Test and verification review")
		expect(cfg.systemPrompt).toContain("tools")
		expect(cfg.systemPrompt).toContain("JSON")
		expect(cfg.systemPrompt).toContain("grade")
	})
})
