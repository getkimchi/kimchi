import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createWorkerReportExtension } from "./worker-report.js"

function registerWorkerReportTool(submit = vi.fn(() => ({ accepted: true, message: "accepted" }))) {
	const registerTool = vi.fn()
	const onAccepted = vi.fn()
	createWorkerReportExtension(
		{ submit, isAccepted: () => false },
		onAccepted,
	)({
		registerTool,
	} as unknown as ExtensionAPI)
	return { tool: registerTool.mock.calls[0]?.[0], submit, onAccepted }
}

describe("worker report capability", () => {
	it("binds a report to its host capability without worker-provided credentials", async () => {
		const { tool, submit, onAccepted } = registerWorkerReportTool()

		expect(tool.parameters.properties).not.toHaveProperty("agent_id")
		expect(tool.parameters.properties).not.toHaveProperty("report_token")
		const result = await tool.execute(
			"call-1",
			{
				status: "completed",
				summary: "done",
				steps_completed: ["implemented"],
				remaining_steps: [],
			},
			undefined,
			undefined,
			undefined,
		)

		expect(submit).toHaveBeenCalledWith({
			status: "completed",
			summary: "done",
			steps_completed: ["implemented"],
			remaining_steps: [],
			files_touched: undefined,
			verification: undefined,
			blockers: undefined,
			notes: undefined,
		})
		expect(onAccepted).toHaveBeenCalledOnce()
		expect(result.content[0].text).toBe("accepted")
	})

	it("keeps the worker running when report validation fails", async () => {
		const { tool, submit, onAccepted } = registerWorkerReportTool()
		const result = await tool.execute(
			"call-1",
			{
				status: "completed",
				summary: "not done",
				steps_completed: [],
				remaining_steps: ["tests"],
			},
			undefined,
			undefined,
			undefined,
		)

		expect(submit).not.toHaveBeenCalled()
		expect(onAccepted).not.toHaveBeenCalled()
		expect(result.content[0].text).toContain("partial")
	})
})
