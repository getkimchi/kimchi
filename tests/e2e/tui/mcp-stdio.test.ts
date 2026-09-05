import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpResourceResult, mcpToolResult } from "./support/mcp-fixture.js"
import {
	directMcpCall,
	emptyMcpCall,
	gatewayMcpCall,
	modelReply,
	requireRequestAdvertisingTool,
	searchMcpTools,
	toolResultText,
} from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

const SENTINEL = "kimchi-mcp-e2e"

test("calls a stdio MCP tool through the real Kimchi session", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: SENTINEL })
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

			expect(toolResultText(fixture.fake.requests, echo)).toContain(`fixture echo: ${SENTINEL}`)
			trace.step("fixture invocation and model-facing tool result verified")
		},
	)
})

test("registers and calls a direct MCP tool on the first session", async ({ terminal }) => {
	const echo = directMcpCall("echo", { message: "direct-first-session" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-direct-tool",
			mcp: {
				directTools: ["echo"],
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: direct-first-session" }] },
							{ message: "direct-first-session" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The direct MCP tool worked without restarting Kimchi.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call the direct MCP echo tool")
			await waitForText(terminal, "The direct MCP tool worked without restarting Kimchi.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			requireRequestAdvertisingTool(fixture.fake.requests, echo.modelToolName)
			const event = await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "direct-first-session" } },
			})
			expect(event.arguments).toEqual({ message: "direct-first-session" })
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: direct-first-session")
			trace.step("first-session direct tool registration and invocation verified")
		},
	)
})

test("does not expose MCP tools in plan mode", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-plan-disabled",
			extraArgs: ["--plan=true"],
			mcp: {
				directTools: ["get_safe"],
				behavior: {
					catalogTools: [
						{
							name: "get_safe",
							description: "Read a safe fixture value",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
							annotations: { readOnlyHint: true },
						},
					],
				},
			},
			responses: [modelReply("MCP tools are unavailable in plan mode.")],
		},
		async (fixture, trace) => {
			terminal.submit("Inspect the available planning tools")
			await waitForText(terminal, "MCP tools are unavailable in plan mode.", { timeoutMs: STREAM_TIMEOUT_MS })

			const request = fixture.fake.requests.find((candidate) => candidate.url.startsWith("/openai/v1/chat/completions"))
			expect(request).toBeDefined()
			const tools = (request?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools ?? []
			expect(tools.some((tool) => tool.function?.name === "mcp")).toBe(false)
			expect(tools.some((tool) => tool.function?.name === "fixture_get_safe")).toBe(false)
			expect(fixture.mcp.hasEvent("tool_called", { name: "get_safe" })).toBe(false)
			trace.step("plan profile omitted both gateway and direct MCP tools")
		},
	)
})

test("delivers an MCP isError result to the next model turn", async ({ terminal }) => {
	const failure = gatewayMcpCall("fail")
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

			expect(toolResultText(fixture.fake.requests, failure)).toContain("Error: fixture failure: requested by test")
			expect(fixture.mcp.hasEvent("tool_called", { name: "fail", arguments: {} })).toBe(true)
			trace.step("MCP isError result reached the model and the turn settled")
		},
	)
})

test("reads an MCP resource through the gateway", async ({ terminal }) => {
	const resource = gatewayMcpCall("read_fixture_note")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-resource",
			mcp: {
				behavior: {
					resources: [
						mcpResourceResult("fixture://note", {
							contents: [
								{
									uri: "fixture://note",
									mimeType: "text/plain",
									text: "fixture resource: kimchi-mcp-resource",
								},
							],
						}),
					],
				},
			},
			responses: [resource.response, modelReply("The MCP resource content reached the model.")],
		},
		async (fixture, trace) => {
			terminal.submit("Read the MCP fixture resource")
			await waitForText(terminal, "The MCP resource content reached the model.", { timeoutMs: STREAM_TIMEOUT_MS })

			const resourceEvent = await fixture.mcp.waitForEvent("resource_read", {
				where: { uri: "fixture://note" },
			})
			expect(resourceEvent.uri).toBe("fixture://note")
			expect(toolResultText(fixture.fake.requests, resource)).toContain("fixture resource: kimchi-mcp-resource")
			trace.step("resource read crossed MCP and model boundaries")
		},
	)
})

test("preserves MCP text and safely represents image content for a text-only model", async ({ terminal }) => {
	const mixedContent = gatewayMcpCall("mixed_content")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-mixed-content",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult("mixed_content", {
							content: [
								{ type: "text", text: "fixture mixed content: kimchi-mcp-mixed" },
								{
									type: "image",
									mimeType: "image/png",
									data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
								},
							],
							structuredContent: { fixture: "kimchi-mcp-structured", count: 1 },
						}),
					],
				},
			},
			responses: [mixedContent.response, modelReply("The MCP text and image content both reached the model.")],
		},
		async (fixture, trace) => {
			terminal.submit("Request mixed text and image content from MCP")
			await waitForText(terminal, "The MCP text and image content both reached the model.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const content = toolResultText(fixture.fake.requests, mixedContent)
			expect(content).toContain("fixture mixed content: kimchi-mcp-mixed")
			expect(content).toContain("[image removed: image/png — stripped for non-vision model compatibility]")
			expect(fixture.mcp.hasEvent("tool_called", { name: "mixed_content", arguments: {} })).toBe(true)
			trace.step("mixed MCP content followed the text-only model compatibility contract")
		},
	)
})

test("calls a discovered tool through the MCP gateway after search", async ({ terminal }) => {
	const search = searchMcpTools("fixture echo")
	const echo = gatewayMcpCall("echo", { message: "search-then-gateway-call" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-search-gateway-call",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: search-then-gateway-call" }] },
							{ message: "search-then-gateway-call" },
						),
					],
				},
			},
			responses: [search.response, echo.response, modelReply("The MCP gateway called the discovered tool.")],
		},
		async (fixture, trace) => {
			terminal.submit("Search MCP and then call the discovered echo tool")
			await waitForText(terminal, "The MCP gateway called the discovered tool.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "search-then-gateway-call" } },
			})
			requireRequestAdvertisingTool(fixture.fake.requests, echo.modelToolName)
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: search-then-gateway-call")
			trace.step("search followed by a gateway invocation of the discovered tool")
		},
	)
})

test("returns MCP server status for an empty gateway call", async ({ terminal }) => {
	const status = emptyMcpCall()
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-empty-call-status",
			mcp: {},
			responses: [status.response, modelReply("The empty MCP gateway call returned server status.")],
		},
		async (fixture, trace) => {
			terminal.submit("Show MCP status through an empty gateway call")
			await waitForText(terminal, "The empty MCP gateway call returned server status.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			expect(toolResultText(fixture.fake.requests, status)).toMatch(/MCP: 1\/1 servers/)
			trace.step("empty gateway call preserved the MCP status contract")
		},
	)
})

test("routes same-named tools across multiple servers using production defaults", async ({ terminal }) => {
	const primaryEcho = gatewayMcpCall("echo", { message: "from-primary" })
	const secondaryEcho = gatewayMcpCall("echo", { message: "from-secondary" }, { serverName: "secondary" })
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
			expect(toolResultText(fixture.fake.requests, primaryEcho)).toContain("fixture echo: from-primary")

			terminal.submit("Call echo on the secondary MCP server")
			await waitForText(terminal, "The secondary MCP server answered.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.server("secondary").waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "from-secondary" } },
			})
			expect(toolResultText(fixture.fake.requests, secondaryEcho)).toContain("fixture echo: from-secondary")
			trace.step("default prefixing routed identical tool names to distinct real MCP servers")
		},
	)
})
