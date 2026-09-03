import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
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
			mcp: {},
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

// Known product bug: asynchronous MCP bootstrap exposes a configured direct tool only after
// the first model request has already been built, so that request rejects the tool as unavailable.
test.fail("registers and calls a direct MCP tool on the first session", async ({ terminal }) => {
	const echo = directMcpCall("echo", { message: "direct-first-session" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-direct-tool",
			mcp: { directTools: ["echo"] },
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

test("delivers an MCP isError result to the next model turn", async ({ terminal }) => {
	const failure = gatewayMcpCall("fail")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-tool-error",
			mcp: {},
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
	const resource = gatewayMcpCall("get_fixture_note")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-resource",
			mcp: {},
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
			mcp: {},
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

test("injects the correctly named direct tool after MCP gateway search", async ({ terminal }) => {
	const search = searchMcpTools("fixture echo")
	const echo = directMcpCall("echo", { message: "search-injected-direct-tool" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-search-direct-injection",
			mcp: {},
			responses: [
				search.response,
				echo.response,
				modelReply("The MCP search-injected tool used the correct original name."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Search MCP and then call the discovered echo tool")
			await waitForText(terminal, "The MCP search-injected tool used the correct original name.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "search-injected-direct-tool" } },
			})
			requireRequestAdvertisingTool(fixture.fake.requests, echo.modelToolName)
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: search-injected-direct-tool")
			trace.step("search injection, direct name mapping, and invocation verified")
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
			mcp: { additionalStdioServers: { secondary: {} } },
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
