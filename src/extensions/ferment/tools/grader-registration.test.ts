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

		// Must be bounded, with room to actually re-run the full verification
		// matrix (build+lint+test+e2e+inspection ≈ 15 tool turns) before the
		// soft turn cap starts steering wrap-up.
		expect(cfg.maxTurns).toBe(25)
		expect(cfg.tokenBudget).toBe(60_000)
		expect(cfg.maxDuration).toBe(600)

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

		// Must prohibit implementation work — no installing deps, no writing files
		expect(cfg.systemPrompt).toContain("verify, don't trust")
		expect(cfg.systemPrompt).toContain("MUST NOT")
		expect(cfg.systemPrompt).toContain("Install, download, or build dependencies")
		expect(cfg.systemPrompt).toContain("Write or create files")
		expect(cfg.systemPrompt).toContain("bash redirects or heredocs")
		expect(cfg.systemPrompt).toContain("Author new test scripts")

		// Must allow inline verification code (independent verification is the grader's job)
		expect(cfg.systemPrompt).toContain("You MAY write inline code to verify specific claims")
		expect(cfg.systemPrompt).toContain("This is NOT implementation work")

		// Must prohibit filesystem searches for runtimes
		expect(cfg.systemPrompt).toContain("Search the filesystem for runtimes or libraries")

		// Must prescribe requirement-driven verification for consistency
		expect(cfg.systemPrompt).toContain("Requirement-driven verification procedure")
		expect(cfg.systemPrompt).toContain("Identify requirements")
		expect(cfg.systemPrompt).toContain("Classify each requirement by test coverage")
		expect(cfg.systemPrompt).toContain("one per requirement")
		// Must verify test coverage before treating a pass as proof
		expect(cfg.systemPrompt).toContain(
			"A passing test only proves a requirement if the test actually tests that requirement",
		)
		expect(cfg.systemPrompt).toContain("A test that passes without actually testing the right thing is NOT covered")
		// Must read source + tests before classifying
		expect(cfg.systemPrompt).toContain("Read the source AND the agent's tests")
		// Must deduplicate verification when one command covers multiple requirements
		expect(cfg.systemPrompt).toContain("that re-run satisfies all of them")
		// Must cap inline checks at one per requirement
		expect(cfg.systemPrompt).toContain("Do not write a second check if the first passes")
	})
})
