import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { gatewayMcpCall, modelReply, searchMcpTools, toolResultText } from "../tui/support/mcp-model-script.js"
import { type AcpMcpFixture, STARTUP_TIMEOUT_MS, startAcpMcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

/**
 * ACP mirror of the TUI mcp-tools-list-changed test: a server that emits
 * notifications/tools/list_changed WITHOUT advertising the capability (the
 * tools-change fixture scenario) must refresh the gateway's tool metadata
 * mid-session on the ACP surface too — the new tool is discoverable through
 * the gateway search without restarting the session.
 */
describe("ACP integration — MCP tools/list_changed", () => {
	let fixture: AcpMcpFixture
	const searchBeforeRotation = searchMcpTools("late_tool")
	const rotate = gatewayMcpCall("rotate_tools")
	const searchAfterRotation = searchMcpTools("late_tool")

	beforeEach(async () => {
		fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-tools-list-changed",
			mcp: { scenario: "tools-change" },
			responses: [
				searchBeforeRotation.response,
				modelReply("Initial search done; late_tool is not advertised yet."),
				rotate.response,
				modelReply("Rotation requested."),
				searchAfterRotation.response,
				modelReply("The gateway refreshed tool metadata after the notification."),
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("refreshes gateway tool metadata when a server emits tools/list_changed mid-session", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		await prompt(fixture, sessionId, "Search the MCP fixture tools for late_tool")
		expect(toolResultText(fixture.fake.requests, searchBeforeRotation)).not.toContain("fixture_late_tool")

		await prompt(fixture, sessionId, "Call rotate_tools on the MCP fixture")
		expect(fixture.mcp.hasEvent("tool_list_changed_sent")).toBe(true)
		// The notification-driven refresh re-lists the server's tools; wait for
		// that re-list so the final search cannot race the refresh.
		const events = fixture.mcp.readEvents()
		const sentIndex = events.findIndex((event) => event.type === "tool_list_changed_sent")
		expect(sentIndex).toBeGreaterThanOrEqual(0)
		await fixture.mcp.waitForEvent("tools_listed", {
			after: sentIndex + 1,
			description: "notification-driven tools re-list",
		})

		await prompt(fixture, sessionId, "Search the MCP fixture tools for late_tool again")
		expect(toolResultText(fixture.fake.requests, searchAfterRotation)).toContain("fixture_late_tool")
	}, 120_000)
})
