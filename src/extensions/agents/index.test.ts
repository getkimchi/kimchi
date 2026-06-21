import { describe, expect, it } from "vitest"
import { buildAgentReportToolResult, summaryForStatus } from "./index.js"

describe("summaryForStatus", () => {
	it("labels token-budget aborts distinctly from max-turn aborts", () => {
		expect(summaryForStatus("aborted", undefined, "token_budget")).toBe("Aborted (token budget exceeded)")
		expect(summaryForStatus("aborted", undefined, "max_turns")).toBe("Aborted (max turns exceeded)")
	})
})

describe("buildAgentReportToolResult", () => {
	it("terminates the worker after an accepted report", () => {
		expect(buildAgentReportToolResult("Agent report recorded.", true)).toMatchObject({
			terminate: true,
			content: [{ type: "text", text: "Agent report recorded." }],
		})
	})

	it("keeps the worker running after a rejected report", () => {
		expect(buildAgentReportToolResult("Invalid report token.")).not.toHaveProperty("terminate")
	})
})
