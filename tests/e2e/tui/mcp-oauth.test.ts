import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, runRestartableMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("logs into an HTTP MCP server with OAuth authorization code and PKCE", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "oauth-login" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-login",
			mcp: {
				transport: "oauth",
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-login" }] },
							{ message: "oauth-login" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The OAuth-authenticated MCP tool returned successfully.")],
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("http_unauthorized", {
				description: "initial OAuth challenge",
			})
			trace.step("protected MCP endpoint challenged the unauthenticated client")

			terminal.submit("/mcp-auth fixture")
			await waitForText(terminal, 'OAuth authentication successful for "fixture"!', {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
				description: "OAuth token exchange with verified PKCE",
			})
			trace.step("browser redirect, callback, and authorization-code exchange completed")

			terminal.submit("/mcp reconnect fixture")
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("Call the OAuth-protected MCP echo tool")
			await waitForText(terminal, "The OAuth-authenticated MCP tool returned successfully.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-login" } },
			})

			expect(fixture.mcp.hasEvent("oauth_resource_metadata_requested")).toBe(true)
			expect(fixture.mcp.hasEvent("oauth_server_metadata_requested")).toBe(true)
			expect(fixture.mcp.hasEvent("oauth_client_registered")).toBe(true)
			expect(fixture.mcp.hasEvent("oauth_browser_opened")).toBe(true)
			expect(fixture.mcp.hasEvent("oauth_browser_completed")).toBe(true)
			expect(fixture.mcp.hasEvent("http_request", { authorized: true })).toBe(true)
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-login")
			trace.step("authenticated MCP call and every OAuth protocol boundary verified")
		},
	)
})

test("automatically authenticates and retries an OAuth-protected MCP call", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "oauth-auto-auth" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-auto-auth",
			mcp: {
				transport: "oauth",
				autoAuth: true,
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-auto-auth" }] },
							{ message: "oauth-auto-auth" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("Automatic MCP OAuth completed without a slash command.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call the protected MCP tool and authenticate automatically")
			await waitForText(terminal, "Automatic MCP OAuth completed without a slash command.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-auto-auth" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-auto-auth")
			trace.step("gateway call initiated OAuth, retried, and returned the protected tool result")
		},
	)
})

test("authenticates a non-interactive MCP server with client credentials", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "oauth-client-credentials" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-client-credentials",
			mcp: {
				transport: "oauth",
				autoAuth: true,
				oauth: {
					grantType: "client_credentials",
					clientId: "kimchi-e2e-client",
					clientSecret: "kimchi-e2e-client-secret",
					scope: "mcp:tools",
				},
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-client-credentials" }] },
							{ message: "oauth-client-credentials" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("MCP client credentials authenticated without a browser.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call the machine-authenticated MCP tool")
			await waitForText(terminal, "MCP client credentials authenticated without a browser.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "client_credentials" },
			})
			expect(fixture.mcp.hasEvent("oauth_browser_opened")).toBe(false)
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-client-credentials" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-client-credentials")
			trace.step("client-credentials token exchange and protected call completed without browser interaction")
		},
	)
})

test("returns an OAuth denial to the TUI and keeps the Kimchi session usable", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-denial",
			mcp: { transport: "oauth", scenario: "oauth-deny" },
			responses: [modelReply("The session stayed usable after OAuth was denied.")],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			await waitForText(terminal, 'Failed to authenticate "fixture": fixture authorization denied', {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("oauth_authorization_denied")
			expect(fixture.mcp.hasEvent("oauth_token_issued")).toBe(false)
			expect(fixture.mcp.hasEvent("oauth_browser_completed")).toBe(true)
			trace.step("authorization denial returned through the callback without storing a token")

			terminal.submit("Continue with a normal response after the denied login")
			await waitForText(terminal, "The session stayed usable after OAuth was denied.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("main session remained usable after OAuth denial")
		},
	)
})

test("reports a failed OAuth token exchange without persisting partial authentication", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-token-failure",
			mcp: { transport: "oauth", scenario: "oauth-token-failure" },
			responses: [],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			await waitForText(terminal, 'Failed to authenticate "fixture"', { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("oauth_token_rejected")
			expect(fixture.mcp.hasEvent("oauth_token_issued")).toBe(false)
			trace.step("token endpoint failure settled and no access token was issued")
		},
	)
})

test("refreshes an expired MCP OAuth token after a real Kimchi process restart", async ({ terminal }) => {
	const beforeRestart = gatewayMcpCall("echo", { message: "before-oauth-restart" })
	const afterRestart = gatewayMcpCall("echo", { message: "after-oauth-refresh" })
	await runRestartableMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-refresh-restart",
			mcp: {
				transport: "oauth",
				scenario: "oauth-expiring",
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: before-oauth-restart" }] },
							{ message: "before-oauth-restart" },
						),
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: after-oauth-refresh" }] },
							{ message: "after-oauth-refresh" },
						),
					],
				},
			},
			responses: [
				beforeRestart.response,
				modelReply("The first OAuth MCP call succeeded."),
				afterRestart.response,
				modelReply("The refreshed OAuth MCP call succeeded after restart."),
			],
		},
		async (fixture, session, trace) => {
			terminal.submit("/mcp-auth fixture")
			await waitForText(terminal, 'OAuth authentication successful for "fixture"!', {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			const initialToken = await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
			})
			terminal.submit("/mcp reconnect fixture")
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			await session.turn("Call MCP before restarting", "The first OAuth MCP call succeeded.")
			expect(toolResultText(fixture.fake.requests, beforeRestart)).toContain("fixture echo: before-oauth-restart")
			await fixture.mcp.waitForOAuthTokenExpiry(initialToken)

			await session.restart()
			trace.step("expired OAuth credentials persisted across a verified process restart")
			await session.turn(
				"Call MCP using the persisted token after restarting",
				"The refreshed OAuth MCP call succeeded after restart.",
			)

			const refresh = await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "refresh_token" },
				description: "OAuth refresh-token exchange after restart",
			})
			expect(refresh.grantType).toBe("refresh_token")
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "after-oauth-refresh" } },
			})
			expect(toolResultText(fixture.fake.requests, afterRestart)).toContain("fixture echo: after-oauth-refresh")
		},
	)
})
