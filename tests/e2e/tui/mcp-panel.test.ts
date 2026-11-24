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
import {
	directMcpCall,
	gatewayMcpCall,
	modelReply,
	requireRequestAdvertisingTool,
	toolResultText,
} from "./support/mcp-model-script.js"

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

				// kimchi defaults the adapter's global config to the Studio-shared
				// harness/mcp.json, so direct-tool choices for global servers persist
				// in place (2.34 behavior). Project-scoped servers keep persisting to
				// the project adapter overlay (.kimchi/mcp-adapter.json).
				const configPath =
					scope === "legacy-project" ? join(fixture.workDir, ".kimchi", "mcp-adapter.json") : fixture.mcp.configPath
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

test("uses this session's private catalog when choosing a direct tool from the MCP panel", async ({ terminal }) => {
	const discover = gatewayMcpCall("echo", { message: "private-catalog-discovery" })
	const direct = directMcpCall("echo", { message: "private-catalog-direct" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-panel-private-session-catalog",
			mcp: {
				transport: "modern-http",
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: private-catalog-discovery" }] },
							{ message: "private-catalog-discovery" },
						),
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: private-catalog-direct" }] },
							{ message: "private-catalog-direct" },
						),
					],
				},
			},
			responses: [
				discover.response,
				modelReply("The private catalog is available in this session."),
				direct.response,
				modelReply("The private-catalog tool became a direct tool."),
			],
		},
		async (fixture, trace) => {
			await sessionTurn(
				terminal,
				"Discover the private MCP catalog",
				"The private catalog is available in this session.",
			)
			await fixture.mcp.waitForEvent("tools_listed")
			trace.step("private modern catalog was listed in the current session")

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
			trace.step("private-catalog tool was visible and saved as direct")

			const saved = JSON.parse(readFileSync(fixture.mcp.configPath, "utf8")) as {
				mcpServers?: Record<string, { directTools?: unknown }>
			}
			const directTools = saved.mcpServers?.fixture?.directTools
			expect(directTools === true || (Array.isArray(directTools) && directTools.includes("echo"))).toBe(true)
			const requestCount = fixture.fake.requests.length
			await sessionTurn(
				terminal,
				"Call the private-catalog direct tool",
				"The private-catalog tool became a direct tool.",
			)
			requireRequestAdvertisingTool(fixture.fake.requests.slice(requestCount), direct.modelToolName)
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "private-catalog-direct" } },
			})
			expect(toolResultText(fixture.fake.requests, direct)).toContain("fixture echo: private-catalog-direct")
		},
	)
})

async function sessionTurn(terminal: Parameters<typeof runMcpKimchiSession>[0], prompt: string, answer: string) {
	terminal.submit(prompt)
	await waitForText(terminal, answer, { timeoutMs: STREAM_TIMEOUT_MS })
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
