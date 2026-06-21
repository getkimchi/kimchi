import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { AgentManager } from "./manager/agent-manager.js"
import { registerResumeSubagentTool } from "./resume-tool.js"

function setupManager() {
	const record = {
		id: "agent-1",
		status: "completed",
		session: {},
		result: "continued",
		latestOutcome: { outcome: "completed" },
	}
	const manager = {
		getRecord: vi.fn(() => record),
		resume: vi.fn(async () => record),
	} as unknown as AgentManager
	const registerTool = vi.fn()
	registerResumeSubagentTool({ registerTool } as unknown as ExtensionAPI, manager)
	return { manager, tool: registerTool.mock.calls[0]?.[0] }
}

describe("resume_subagent", () => {
	it("inherits spawn-only configuration instead of accepting it again", () => {
		const { tool } = setupManager()
		const properties = tool.parameters.properties

		expect(properties).toHaveProperty("agent_id")
		expect(properties).toHaveProperty("prompt")
		expect(properties).toHaveProperty("max_turns")
		expect(properties).toHaveProperty("max_duration")
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
})
