import { mkdirSync, readFileSync, renameSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import {
	PROMPT_READY,
	runMcpKimchiSession,
	runRestartableMcpKimchiSession,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import { directMcpCall, modelReply, requireRequestAdvertisingTool, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

for (const scope of ["global", "legacy-project"]) {
	test(`persists a direct-tool choice from the ${scope} MCP panel and applies it after restart`, async ({
		terminal,
	}) => {
		const echo = directMcpCall("echo", { message: "panel-persisted" })
		await runRestartableMcpKimchiSession(
			terminal,
			{
				artifactName: `mcp-panel-persistence-${scope}`,
				extraArgs: ["--approve"],
				seedHome: (homeDir, workDir) => {
					if (scope !== "legacy-project") return
					const legacyPath = join(workDir, ".kimchi", "mcp.json")
					mkdirSync(dirname(legacyPath), { recursive: true })
					renameSync(join(homeDir, ".config", "kimchi", "harness", "mcp.json"), legacyPath)
				},
				mcp: {
					behavior: {
						tools: [
							mcpToolResult(
								"echo",
								{ content: [{ type: "text", text: "fixture echo: panel-persisted" }] },
								{ message: "panel-persisted" },
							),
						],
					},
				},
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
				await waitForText(terminal, "Direct tools updated for this session.", { timeoutMs: STREAM_TIMEOUT_MS })
				trace.step("echo toggled to direct and saved")

				const configPath =
					scope === "legacy-project" ? join(fixture.workDir, ".kimchi", "mcp.json") : fixture.mcp.configPath
				const saved = JSON.parse(readFileSync(configPath, "utf-8")) as {
					mcpServers?: Record<string, { directTools?: unknown }>
				}
				expect(saved.mcpServers?.fixture?.directTools).toEqual(["echo"])

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
}

test("deselecting a direct MCP tool removes it from subsequent model requests", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-panel-deselect-direct-tool",
			mcp: { directTools: ["echo"] },
			responses: [modelReply("The direct tool is available."), modelReply("The deselected direct tool stays hidden.")],
		},
		async (fixture, trace) => {
			terminal.submit("Inspect the configured tools")
			await waitForText(terminal, "The direct tool is available.", { timeoutMs: STREAM_TIMEOUT_MS })
			requireRequestAdvertisingTool(fixture.fake.requests, "fixture_echo")
			trace.step("the first model request advertised the selected direct tool")

			terminal.write("/mcp")
			await waitForText(terminal, "/mcp")
			terminal.submit("")
			await waitForText(terminal, "MCP Servers", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "echo", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.keyDown()
			terminal.keyPress(" ")
			terminal.keyPress("s", { ctrl: true })
			await waitForText(terminal, "Direct tools updated for this session.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("the user deselected echo and saved the panel")

			const requestCount = fixture.fake.requests.length
			terminal.submit("Inspect the tools after deselecting echo")
			await waitForText(terminal, "The deselected direct tool stays hidden.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(() => requireRequestAdvertisingTool(fixture.fake.requests.slice(requestCount), "fixture_echo")).toThrow()
			requireRequestAdvertisingTool(fixture.fake.requests.slice(requestCount), "mcp")
			trace.step("the next model request kept the gateway but excluded the deselected direct tool")
		},
	)
})
