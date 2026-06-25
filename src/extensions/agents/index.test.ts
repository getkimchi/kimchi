import { describe, expect, it } from "vitest"
import { AGENT_TOOL_GUIDELINES, summaryForStatus } from "./index.js"

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
		expect(AGENT_TOOL_GUIDELINES).toContain("The parent orchestrator should consume the returned findings directly")
		expect(AGENT_TOOL_GUIDELINES).toContain("Return decision-ready findings to the parent; do not write files.")
		expect(AGENT_TOOL_GUIDELINES).toContain("write a complete implementation spec")
	})
})
