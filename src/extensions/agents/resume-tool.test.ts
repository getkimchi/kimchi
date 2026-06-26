import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { AgentManager } from "./manager/agent-manager.js"
import { registerResumeSubagentTool } from "./resume-tool.js"

function setupManager() {
	const record = {
		id: "agent-1",
		status: "completed",
		currentAttemptId: 0,
		session: {},
		result: "continued",
		latestOutcome: { outcome: "completed" },
		agentReport: undefined as { attempt_id: number; status: "completed" } | undefined,
	}
	const manager = {
		getRecord: vi.fn(() => record),
		getResumeBlockReason: vi.fn(() =>
			record.agentReport?.attempt_id === record.currentAttemptId && record.agentReport.status === "completed"
				? `Agent "${record.id}" already has an accepted completed report for its current attempt.`
				: undefined,
		),
		resume: vi.fn(async () => record),
	} as unknown as AgentManager
	const registerTool = vi.fn()
	registerResumeSubagentTool({ registerTool } as unknown as ExtensionAPI, manager)
	return { manager, record, tool: registerTool.mock.calls[0]?.[0] }
}

describe("resume_subagent", () => {
	it("inherits spawn-only configuration instead of accepting it again", () => {
		const { tool } = setupManager()
		const properties = tool.parameters.properties

		expect(properties).toHaveProperty("agent_id")
		expect(properties).toHaveProperty("prompt")
		expect(properties).toHaveProperty("max_turns")
		expect(properties).toHaveProperty("max_duration")
		expect(JSON.stringify(properties.purpose)).toContain('"continue"')
		expect(properties).not.toHaveProperty("subagent_type")
		expect(properties).not.toHaveProperty("description")
		expect(properties).not.toHaveProperty("model")
		expect(properties).not.toHaveProperty("task_ref")
	})

	it("continues the existing session with a bounded attempt", async () => {
		const { manager, tool } = setupManager()
		const result = await tool.execute(
			"call-1",
			{
				agent_id: "agent-1",
				prompt: "finish tests",
				max_turns: 3,
				max_duration: 60,
				token_budget: 4096,
				purpose: "continuation",
			},
			undefined,
			undefined,
			undefined,
		)

		expect(manager.resume).toHaveBeenCalledWith("agent-1", "finish tests", {
			signal: undefined,
			maxTurns: 3,
			maxDuration: 60,
			tokenBudget: 4096,
			purpose: "continuation",
		})
		expect(result.details).toMatchObject({
			agentId: "agent-1",
			status: "completed",
			agentOutcome: { outcome: "completed" },
		})
	})

	it('accepts purpose "continue" as a compatibility alias for continuation', async () => {
		const { manager, tool } = setupManager()

		await tool.execute(
			"call-1",
			{
				agent_id: "agent-1",
				prompt: "finish tests",
				max_turns: 3,
				max_duration: 60,
				purpose: "continue",
			},
			undefined,
			undefined,
			undefined,
		)

		expect(manager.resume).toHaveBeenCalledWith("agent-1", "finish tests", {
			signal: undefined,
			maxTurns: 3,
			maxDuration: 60,
			tokenBudget: undefined,
			purpose: "continuation",
		})
	})

	it("finalizes a report without caller-supplied prompt or budgets", async () => {
		const { manager, tool } = setupManager()
		expect(tool.parameters.required).toEqual(["agent_id"])

		await tool.execute("call-1", { agent_id: "agent-1", purpose: "finalize_report" }, undefined, undefined, undefined)

		expect(manager.resume).toHaveBeenCalledWith("agent-1", undefined, {
			signal: undefined,
			purpose: "finalize_report",
		})
	})

	it("clearly refuses to resume an accepted completed report", async () => {
		const { manager, record, tool } = setupManager()
		record.agentReport = { attempt_id: 0, status: "completed" }

		const result = await tool.execute(
			"call-1",
			{ agent_id: "agent-1", prompt: "continue", max_turns: 2, max_duration: 30 },
			undefined,
			undefined,
			undefined,
		)

		expect(manager.resume).not.toHaveBeenCalled()
		expect(result.content[0]?.text).toContain("already has an accepted completed report")
	})

	it("returns a clear refusal when host policy blocks the resume", async () => {
		const { manager, tool } = setupManager()
		vi.mocked(manager.getResumeBlockReason).mockReturnValue("Continuation resume limit reached.")

		const result = await tool.execute(
			"call-1",
			{ agent_id: "agent-1", prompt: "continue", max_turns: 2, max_duration: 30 },
			undefined,
			undefined,
			undefined,
		)

		expect(manager.resume).not.toHaveBeenCalled()
		expect(result.content[0]?.text).toBe("Continuation resume limit reached.")
	})
})
