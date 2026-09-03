import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("calls a Streamable HTTP MCP tool and preserves configured headers", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "streamable-http" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-http",
			mcp: { transport: "http", headers: { "X-Kimchi-E2E": "fixture-header" } },
			responses: [echo.response, modelReply("The Streamable HTTP MCP tool returned successfully.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call the MCP fixture over Streamable HTTP")
			await waitForText(terminal, "The Streamable HTTP MCP tool returned successfully.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const call = await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "streamable-http" } },
			})
			expect(call.name).toBe("echo")
			const requests = fixture.mcp.eventsOfType("http_request")
			expect(requests.some((event) => event.testHeader === "fixture-header")).toBe(true)
			expect(requests.some((event) => Boolean(event.sessionId))).toBe(true)
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: streamable-http")
			trace.step("Streamable HTTP session, custom header, and model-facing result verified")
		},
	)
})

test("authenticates to a Streamable HTTP MCP server with a static bearer token", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "bearer-authenticated" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-http-bearer",
			mcp: { transport: "http", bearerToken: "kimchi-e2e-bearer-token" },
			responses: [echo.response, modelReply("The authenticated MCP request succeeded.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call the bearer-protected MCP fixture")
			await waitForText(terminal, "The authenticated MCP request succeeded.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "bearer-authenticated" } },
			})
			expect(fixture.mcp.hasEvent("http_request", { authorized: true })).toBe(true)
			expect(fixture.mcp.hasEvent("http_unauthorized")).toBe(false)
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: bearer-authenticated")
			trace.step("static bearer authentication verified at the fixture boundary")
		},
	)
})

test("falls back from Streamable HTTP to the legacy MCP SSE transport", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "legacy-sse" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-sse-fallback",
			mcp: { transport: "sse" },
			responses: [echo.response, modelReply("Kimchi completed the MCP call through SSE fallback.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call MCP through the legacy SSE fallback")
			await waitForText(terminal, "Kimchi completed the MCP call through SSE fallback.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "legacy-sse" } },
			})
			expect(fixture.mcp.hasEvent("sse_streamable_rejected")).toBe(true)
			expect(fixture.mcp.hasEvent("sse_session_initialized")).toBe(true)
			expect(fixture.mcp.hasEvent("sse_message")).toBe(true)
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: legacy-sse")
			trace.step("Streamable HTTP failure and successful SSE fallback both observed")
		},
	)
})

test("keeps Kimchi usable when an HTTP MCP server returns malformed protocol data", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", {})
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-http-malformed",
			mcp: { transport: "http", scenario: "http-malformed" },
			responses: [echo.response, modelReply("Kimchi remained usable after malformed MCP HTTP data.")],
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("http_malformed_response")
			terminal.submit("Continue after malformed MCP HTTP data")
			await waitForText(terminal, "Kimchi remained usable after malformed MCP HTTP data.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			expect(toolResultText(fixture.fake.requests, echo)).toMatch(/failed|not (?:available|connected)|not found/i)
			trace.step("malformed HTTP protocol data remained isolated from the main session")
		},
	)
})

test("settles a tool call when a connected HTTP MCP server becomes unavailable", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "server-is-down" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-http-unavailable",
			mcp: { transport: "http" },
			responses: [echo.response, modelReply("Kimchi recovered from the unavailable HTTP MCP server.")],
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("tools_listed")
			await fixture.mcp.stop()
			terminal.submit("Call the MCP server after it becomes unavailable")
			await waitForText(terminal, "Kimchi recovered from the unavailable HTTP MCP server.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("Failed to call tool")
			trace.step("HTTP transport loss became a model-facing error and the turn settled")
		},
	)
})
