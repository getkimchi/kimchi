import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { gatewayMcpCall, modelReply, searchMcpTools, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

/**
 * A server that emits notifications/tools/list_changed WITHOUT advertising
 * the tools.listChanged capability (the Studio slack-wrapper / relayed-gateway
 * shape) must still refresh the gateway's tool metadata live: the new tool is
 * discoverable through mcp search without restarting the session.
 */
test("refreshes gateway tool metadata when a server emits tools/list_changed mid-session", async ({ terminal }) => {
	const searchBeforeRotation = searchMcpTools("late_tool")
	const rotate = gatewayMcpCall("rotate_tools")
	const searchAfterRotation = searchMcpTools("late_tool")

	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-tools-list-changed",
			mcp: { scenario: "tools-change" },
			responses: [
				searchBeforeRotation.response,
				modelReply("Initial search done; late_tool is not advertised yet."),
				rotate.response,
				modelReply("Rotation requested."),
				searchAfterRotation.response,
				modelReply("The gateway refreshed tool metadata after the notification."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Search the MCP fixture tools for late_tool")
			await waitForText(terminal, "Initial search done; late_tool is not advertised yet.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("pre-rotation search completed")

			// The search matches descriptions too, and rotate_tools' description
			// names the tool it adds — assert on the tool's identity instead.
			expect(toolResultText(fixture.fake.requests, searchBeforeRotation)).not.toContain("fixture_late_tool")

			terminal.submit("Call rotate_tools on the MCP fixture")
			await waitForText(terminal, "Rotation requested.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("rotation tool called")

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
			trace.step("notification consumed; tools re-listed")

			terminal.submit("Search the MCP fixture tools for late_tool again")
			await waitForText(terminal, "The gateway refreshed tool metadata after the notification.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("post-rotation search completed")

			const searchResult = toolResultText(fixture.fake.requests, searchAfterRotation)
			expect(searchResult).toContain("fixture_late_tool")
			trace.step("late_tool visible to the model after the refresh")
		},
	)
})
