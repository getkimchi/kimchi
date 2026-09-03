import { readFileSync } from "node:fs"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runRestartableMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { directMcpCall, modelReply, requireRequestAdvertisingTool, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("persists a direct-tool choice from the MCP panel and applies it after restart", async ({ terminal }) => {
	const echo = directMcpCall("echo", { message: "panel-persisted" })
	await runRestartableMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-panel-persistence",
			mcp: {},
			responses: [echo.response, modelReply("The MCP panel direct-tool choice survived restart.")],
		},
		async (fixture, session, trace) => {
			terminal.write("/mcp")
			await waitForText(terminal, "/mcp")
			terminal.submit("")
			await waitForText(terminal, "MCP Servers", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("MCP panel opened with the fixture server selected")

			terminal.submit("")
			await waitForText(terminal, "echo", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.keyDown()
			terminal.keyPress(" ")
			terminal.keyPress("s", { ctrl: true })
			await waitForText(terminal, "Saved", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("echo toggled to direct and saved")

			const saved = JSON.parse(readFileSync(fixture.mcp.configPath, "utf-8")) as {
				mcpServers?: Record<string, { directTools?: unknown }>
			}
			expect(saved.mcpServers?.fixture?.directTools).toEqual(["echo"])

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STREAM_TIMEOUT_MS })
			await session.restart()
			await session.turn(
				"Call the direct tool enabled in the MCP panel",
				"The MCP panel direct-tool choice survived restart.",
			)

			requireRequestAdvertisingTool(fixture.fake.requests, echo.modelToolName)
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "panel-persisted" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: panel-persisted")
			trace.step("persisted direct tool was advertised and called after restart")
		},
	)
})
