import { describe, expect, it } from "vitest"
import { AGENT_MODEL_PARAMETER_DESCRIPTION, AGENT_TOOL_GUIDELINES, summaryForStatus } from "./index.js"

describe("summaryForStatus", () => {
	it("labels token-budget aborts distinctly from max-turn aborts", () => {
		expect(summaryForStatus("aborted", undefined, "token_budget")).toBe("Aborted (token budget exceeded)")
		expect(summaryForStatus("aborted", undefined, "max_turns")).toBe("Aborted (max turns exceeded)")
	})
})

describe("AGENT_TOOL_GUIDELINES", () => {
	it("tells orchestrators to keep Explore prompts narrow and read-only", () => {
		expect(AGENT_TOOL_GUIDELINES).toContain("one decision-relevant question")
		expect(AGENT_TOOL_GUIDELINES).toContain("a qualitative stop condition tied to that question")
		expect(AGENT_TOOL_GUIDELINES).toContain("Explore is read-only")
		expect(AGENT_TOOL_GUIDELINES).toContain("Do not ask Explore agents to write reports")
		expect(AGENT_TOOL_GUIDELINES).toContain("You should consume the returned findings directly")
		expect(AGENT_TOOL_GUIDELINES).toContain("Return decision-ready findings to the parent; do not write files.")
		expect(AGENT_TOOL_GUIDELINES).toContain("write a complete implementation spec")
	})
})

describe("AGENT_MODEL_PARAMETER_DESCRIPTION", () => {
	it("describes model fallback without referring to orchestrator-only prompt sections", () => {
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).toContain("If omitted, the agent uses the current session model")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).toContain("Follow your system prompt's delegation rules")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).toContain("Partial model IDs")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).toContain("specify the full versioned model ID")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).not.toContain("Your Team")
		expect(AGENT_MODEL_PARAMETER_DESCRIPTION).not.toContain("orchestration mode")
	})
})
