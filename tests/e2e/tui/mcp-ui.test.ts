import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpResourceResult, mcpToolResult } from "./support/mcp-fixture.js"
import { gatewayMcpCall, modelReply } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

// Kimchi does not yet properly support the MCP UI standard, so the feature is
// disabled via the dependency patch (see docs/mcp-adapter-audit.md): MCP App
// tools degrade to plain tools whose results return inline, the client never
// advertises the ui extension capability, and no UI host, browser window, or
// ui:// resource read ever happens.
test("runs an MCP App tool inline without opening a UI host", async ({ terminal }) => {
	const openUi = gatewayMcpCall("open_ui")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-ui-disabled",
			mcp: {
				scenario: "ui-app",
				behavior: {
					tools: [
						mcpToolResult("open_ui", {
							content: [{ type: "text", text: "fixture MCP App tool ran without a UI host" }],
						}),
					],
					resources: [
						mcpResourceResult("ui://fixture/app", {
							contents: [
								{
									uri: "ui://fixture/app",
									mimeType: "text/html;profile=mcp-app",
									text: '<!doctype html><html><body><main id="kimchi-mcp-app">Kimchi MCP App fixture</main></body></html>',
								},
							],
						}),
					],
				},
			},
			responses: [openUi.response, modelReply("The MCP App tool returned its result inline.")],
		},
		async (fixture, trace) => {
			terminal.submit("Open the fixture MCP App tool")
			await waitForText(terminal, "The MCP App tool returned its result inline.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", { where: { name: "open_ui" } })
			trace.step("the UI-decorated tool call completed")

			// The handshake is the first disable surface: the adapter must not
			// advertise the MCP UI extension capability. The client name is the
			// positive control proving the handshake was actually observed, so the
			// capability assertion cannot pass vacuously.
			const initialized = fixture.mcp.readEvents().find((event) => event.type === "initialized")
			expect(initialized).toBeDefined()
			expect(initialized?.clientName).toBe("pi-mcp-fixture")
			expect(initialized?.extensionCapabilities).not.toContain("io.modelcontextprotocol/ui")

			// Any UI session would start before the tool result reaches the model,
			// so by the time the reply renders, absence is settled. The fake browser
			// driver stays wired via the ui-app scenario, so a regression that
			// re-enables the UI would record these events and fail the assertions.
			const events = fixture.mcp.readEvents()
			expect(events.some((event) => event.type === "ui_browser_opened")).toBe(false)
			expect(events.some((event) => event.type === "ui_host_loaded")).toBe(false)
			expect(events.some((event) => event.type === "resource_read" && event.uri === "ui://fixture/app")).toBe(false)
			trace.step("no browser window, UI host, or ui:// resource read ever happened")
		},
	)
})
