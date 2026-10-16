import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import { directMcpCall, modelReply, requireRequestAdvertisingTool, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

const SENTINEL = "kimchi-mcp-e2e"

test("calls a stdio MCP tool through the real Kimchi session (native direct tool)", async ({ terminal }) => {
	const echo = directMcpCall("echo", { message: SENTINEL })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: `fixture echo: ${SENTINEL}` }] },
							{ message: SENTINEL },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The MCP fixture returned the expected echo.")],
		},
		async (fixture, trace) => {
			terminal.submit("Use the MCP fixture to echo the test sentinel")

			await waitForText(terminal, "The MCP fixture returned the expected echo.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("final response visible after MCP tool result")

			const called = await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: SENTINEL } },
				description: "echo tool invocation",
			})
			expect(called.arguments).toEqual({ message: SENTINEL })
			expect(fixture.mcp.hasEvent("initialized")).toBe(true)
			expect(fixture.mcp.hasEvent("tools_listed")).toBe(true)

			requireRequestAdvertisingTool(fixture.fake.requests, echo.modelToolName)
			expect(toolResultText(fixture.fake.requests, echo)).toContain(`fixture echo: ${SENTINEL}`)
			trace.step("fixture invocation, model advertisement, and model-facing tool result verified")
		},
	)
})

test("delivers an MCP isError result to the next model turn", async ({ terminal }) => {
	const failure = directMcpCall("fail")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-tool-error",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult("fail", {
							isError: true,
							content: [{ type: "text", text: "fixture failure: requested by test" }],
						}),
					],
				},
			},
			responses: [failure.response, modelReply("Kimchi handled the MCP tool error and the session continued.")],
		},
		async (fixture, trace) => {
			terminal.submit("Exercise the MCP fixture failure")
			await waitForText(terminal, "Kimchi handled the MCP tool error and the session continued.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			// Native (unlike the adapter) delivers isError text verbatim, no "Error: " prefix.
			expect(toolResultText(fixture.fake.requests, failure)).toContain("fixture failure: requested by test")
			expect(fixture.mcp.hasEvent("tool_called", { name: "fail", arguments: {} })).toBe(true)
			trace.step("MCP isError result reached the model and the turn settled")
		},
	)
})

test("routes same-named tools across multiple servers with native namespacing", async ({ terminal }) => {
	const primaryEcho = directMcpCall("echo", { message: "from-primary" })
	const secondaryEcho = directMcpCall("echo", { message: "from-secondary" }, { serverName: "secondary" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-multiple-servers",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: from-primary" }] },
							{ message: "from-primary" },
						),
					],
				},
				additionalStdioServers: {
					secondary: {
						behavior: {
							tools: [
								mcpToolResult(
									"echo",
									{ content: [{ type: "text", text: "fixture echo: from-secondary" }] },
									{ message: "from-secondary" },
								),
							],
						},
					},
				},
			},
			responses: [
				primaryEcho.response,
				modelReply("The primary MCP server answered."),
				secondaryEcho.response,
				modelReply("The secondary MCP server answered."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Call echo on the primary MCP server")
			await waitForText(terminal, "The primary MCP server answered.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "from-primary" } },
			})
			expect(fixture.mcp.server("secondary").hasEvent("tool_called", { name: "echo" })).toBe(false)
			expect(primaryEcho.modelToolName).not.toBe(secondaryEcho.modelToolName)
			expect(toolResultText(fixture.fake.requests, primaryEcho)).toContain("fixture echo: from-primary")

			terminal.submit("Call echo on the secondary MCP server")
			await waitForText(terminal, "The secondary MCP server answered.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.server("secondary").waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "from-secondary" } },
			})
			expect(toolResultText(fixture.fake.requests, secondaryEcho)).toContain("fixture echo: from-secondary")
			trace.step("native mcp__<server>__<tool> namespacing routed identical tool names to distinct servers")
		},
	)
})
