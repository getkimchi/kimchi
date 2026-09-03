import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { gatewayMcpCall, mcpUiMessages, modelReply, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("bridges an MCP App tool call and prompt back into the agent", async ({ terminal }) => {
	const openUi = gatewayMcpCall("open_ui")
	const uiMessages = mcpUiMessages()
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-ui-app-bridge",
			mcp: { scenario: "ui-app" },
			responses: [
				openUi.response,
				modelReply("The MCP App opened."),
				modelReply("The MCP App prompt triggered an agent turn."),
				uiMessages.response,
				modelReply("The completed MCP App messages reached the model."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Open the fixture MCP App")
			await waitForText(terminal, "The MCP App opened.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("resource_read", { where: { uri: "ui://fixture/app" } })
			await fixture.mcp.waitForEvent("ui_host_loaded", { where: { status: 200 } })
			const ui = fixture.mcp.ui
			expect(ui).toBeDefined()
			if (!ui) throw new Error("MCP UI fixture was not configured")
			trace.step("MCP App resource loaded in the local browser host")

			await ui.post("/proxy/ui/consent", { approved: true })
			const proxied = await ui.post("/proxy/tools/call", {
				name: "echo",
				arguments: { message: "from-ui" },
			})
			expect(proxied?.ok).toBe(true)
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "from-ui" } },
			})
			trace.step("MCP App called a server tool through the consent-gated bridge")

			await ui.post("/proxy/ui/message", {
				type: "prompt",
				prompt: "continue from the fixture app",
			})
			await waitForText(terminal, "The MCP App prompt triggered an agent turn.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await ui.post("/proxy/ui/complete", { reason: "done" })
			trace.step("UI prompt triggered a deterministic follow-up turn and the app completed")

			terminal.submit("Retrieve the completed MCP App messages")
			await waitForText(terminal, "The completed MCP App messages reached the model.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			expect(toolResultText(fixture.fake.requests, uiMessages)).toContain("continue from the fixture app")
			trace.step("completed UI messages crossed the MCP gateway and model boundary")
		},
	)
})

test("denies MCP App tool access without consent and tears down on completion", async ({ terminal }) => {
	const openUi = gatewayMcpCall("open_ui")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-ui-consent-denial",
			mcp: { scenario: "ui-app" },
			responses: [openUi.response, modelReply("The consent-gated MCP App opened.")],
		},
		async (fixture, trace) => {
			terminal.submit("Open the consent-gated fixture MCP App")
			await waitForText(terminal, "The consent-gated MCP App opened.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("ui_host_loaded", { where: { status: 200 } })
			const ui = fixture.mcp.ui
			expect(ui).toBeDefined()
			if (!ui) throw new Error("MCP UI fixture was not configured")
			const beforeDeniedCall = fixture.mcp.checkpoint()

			await ui.post("/proxy/ui/consent", { approved: false })
			const denied = await ui.request("/proxy/tools/call", {
				name: "echo",
				arguments: { message: "must-not-run" },
			})
			expect(denied.status).toBe(403)
			expect(denied.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/denied/i) }))
			expect(
				fixture.mcp
					.readEvents()
					.slice(beforeDeniedCall)
					.some(
						(event) =>
							event.type === "tool_called" && event.name === "echo" && event.arguments.message === "must-not-run",
					),
			).toBe(false)
			trace.step("denied consent blocked the UI tool call before MCP dispatch")

			await ui.post("/proxy/ui/complete", { reason: "denied" })
			await ui.waitForClosed()
			trace.step("completing the denied app closed its local UI host")
		},
	)
})
