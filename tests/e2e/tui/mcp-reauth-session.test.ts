import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import {
	connectMcpServer,
	gatewayMcpCall,
	modelReply,
	requestAdvertisesTool,
	requestWithToolResult,
	requireRequestAdvertisingTool,
	searchMcpTools,
	toolResultText,
} from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

// Model-facing namespace-proxy tool name for the fixture server (pi-mcp-adapter
// namespace-tools: one mcp__<server> proxy tool per proxy-only server).
const NAMESPACE_PROXY_TOOL = "mcp__fixture"

test("restores in-session MCP access when /mcp-auth reconnects after a revoked refresh token", async ({ terminal }) => {
	const beforeRevocation = gatewayMcpCall("echo", { message: "before-revocation" })
	const whileRevoked = gatewayMcpCall("echo", { message: "while-revoked" })
	const afterReauth = gatewayMcpCall("echo", { message: "after-reauth" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-reauth-session",
			mcp: {
				transport: "oauth",
				scenario: "oauth-refresh-revoked",
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: before-revocation" }] },
							{ message: "before-revocation" },
						),
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: while-revoked" }] },
							{ message: "while-revoked" },
						),
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: after-reauth" }] },
							{ message: "after-reauth" },
						),
					],
				},
			},
			responses: [
				beforeRevocation.response,
				modelReply("Authenticated; the protected MCP call worked."),
				whileRevoked.response,
				modelReply("The protected call now requires re-authentication."),
				afterReauth.response,
				modelReply("Re-auth restored MCP access in the same session."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			const initialToken = await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
			})
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("initial OAuth login completed and reconnected")

			terminal.submit("Call the protected MCP tool")
			await waitForText(terminal, "Authenticated; the protected MCP call worked.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "before-revocation" } },
			})
			expect(toolResultText(fixture.fake.requests, beforeRevocation)).toContain("fixture echo: before-revocation")
			requireRequestAdvertisingTool(fixture.fake.requests, NAMESPACE_PROXY_TOOL)
			trace.step("protected call succeeded while the session advertised the fixture tools")

			await fixture.mcp.waitForOAuthTokenExpiry(initialToken)
			trace.step("access token expired; this fixture rejects every refresh grant")

			terminal.submit("Call the protected MCP tool after the token died")
			await waitForText(terminal, "The protected call now requires re-authentication.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("oauth_refresh_rejected")
			expect(fixture.mcp.hasEvent("tool_called", { name: "echo", arguments: { message: "while-revoked" } })).toBe(false)
			expect(toolResultText(fixture.fake.requests, whileRevoked)).toMatch(/auth|401|unauthorized|log ?in/i)
			// Verified contract: an auth-required failure keeps the server's tools
			// advertised (only hard connection failures remove them), so the model at
			// least sees an actionable auth error rather than an empty toolbox.
			const failureRequest = requestWithToolResult(fixture.fake.requests, whileRevoked.id)
			expect(requestAdvertisesTool(failureRequest, NAMESPACE_PROXY_TOOL)).toBe(true)
			trace.step("the auth failure kept the fixture tools advertised")

			terminal.submit("/mcp-auth fixture")
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				predicate: (event) =>
					event.grantType === "authorization_code" && Date.parse(event.at) > Date.parse(initialToken.at),
				description: "second authorization-code grant after the revocation",
			})
			const requestCheckpoint = fixture.fake.requests.length
			trace.step("re-auth completed; its reconnect follows")

			terminal.submit("Call the protected MCP tool after re-authenticating")
			await waitForText(terminal, "Re-auth restored MCP access in the same session.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "after-reauth" } },
			})
			expect(toolResultText(fixture.fake.requests, afterReauth)).toContain("fixture echo: after-reauth")
			expect(
				fixture.fake.requests
					.slice(requestCheckpoint)
					.some((request) => requestAdvertisesTool(request, NAMESPACE_PROXY_TOOL)),
			).toBe(true)
			trace.step("tools came back and worked without starting a new chat")
		},
	)
})

test("drops and restores in-session tool discovery across a hard disconnect and reconnect", async ({ terminal }) => {
	const beforeCrash = gatewayMcpCall("echo", { message: "before-crash" })
	const crashCall = gatewayMcpCall("disconnect")
	const searchAfterCrash = searchMcpTools("echo")
	const reconnectCall = connectMcpServer("fixture")
	const searchAfterReconnect = searchMcpTools("echo")
	const afterReconnect = gatewayMcpCall("echo", { message: "after-reconnect" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-reconnect-session",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: before-crash" }] },
							{ message: "before-crash" },
						),
						{ name: "disconnect", response: { type: "exit", code: 17 } },
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: after-reconnect" }] },
							{ message: "after-reconnect" },
						),
					],
				},
			},
			responses: [
				beforeCrash.response,
				modelReply("The MCP echo worked."),
				crashCall.response,
				modelReply("The MCP server died during the call."),
				searchAfterCrash.response,
				modelReply("Search after the crash returned."),
				reconnectCall.response,
				modelReply("Reconnected to the MCP server."),
				searchAfterReconnect.response,
				modelReply("Search after the reconnect returned."),
				afterReconnect.response,
				modelReply("MCP is back in the same session."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Call the MCP tool before the crash")
			await waitForText(terminal, "The MCP echo worked.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("tool_called", { where: { name: "echo", arguments: { message: "before-crash" } } })
			requireRequestAdvertisingTool(fixture.fake.requests, NAMESPACE_PROXY_TOOL)
			trace.step("tool call succeeded while the session advertised the fixture tools")

			terminal.submit("Call the MCP tool that crashes its server")
			await waitForText(terminal, "The MCP server died during the call.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("process_exited", { where: { code: 17 } })
			expect(toolResultText(fixture.fake.requests, crashCall)).toContain("Failed to call tool")
			trace.step("hard disconnect surfaced as a model-facing tool error")

			terminal.submit("Search MCP tools after the crash")
			await waitForText(terminal, "Search after the crash returned.", { timeoutMs: STREAM_TIMEOUT_MS })
			// Model-facing discovery post-crash: the crashed server must drop out
			// of search results (the catalog stops serving it mid-session).
			const postCrashSearch = toolResultText(fixture.fake.requests, searchAfterCrash)
			expect(postCrashSearch).not.toContain("fixture_echo")
			trace.step("post-crash search stopped listing the crashed server's tools")

			terminal.submit("Reconnect to the MCP server")
			await waitForText(terminal, "Reconnected to the MCP server.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("model-driven reconnect respawned the fixture server")

			terminal.submit("Search MCP tools after the reconnect")
			await waitForText(terminal, "Search after the reconnect returned.", { timeoutMs: STREAM_TIMEOUT_MS })
			const postReconnectSearch = toolResultText(fixture.fake.requests, searchAfterReconnect)
			expect(postReconnectSearch).toContain("fixture_echo")
			trace.step("post-reconnect search lists the server's tools again")

			terminal.submit("Call the MCP tool after reconnecting")
			await waitForText(terminal, "MCP is back in the same session.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "after-reconnect" } },
			})
			expect(toolResultText(fixture.fake.requests, afterReconnect)).toContain("fixture echo: after-reconnect")
			trace.step("the same session recovered after an explicit reconnect")
		},
	)
})
