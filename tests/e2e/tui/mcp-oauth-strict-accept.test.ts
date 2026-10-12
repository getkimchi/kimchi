import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

// Regression proof for the OAuth Accept-header patch: spec-strict gateways
// (e.g. agentgateway v1.5.0) answer 406 when the metadata-discovery GET or the
// DCR POST lack "text/event-stream" in Accept. The fixture's strictAccept mode
// emulates that gateway: the whole login only completes if the binary sends
// "application/json, text/event-stream" on those endpoints.
test("completes MCP OAuth login against a spec-strict gateway requiring text/event-stream", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "oauth-strict-accept" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-strict-accept",
			mcp: {
				transport: "oauth",
				strictAccept: true,
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-strict-accept" }] },
							{ message: "oauth-strict-accept" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("OAuth login succeeded against the spec-strict gateway.")],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
				description: "OAuth token exchange against the spec-strict gateway",
			})
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("authorization-code flow completed against the spec-strict gateway")

			expect(fixture.mcp.hasEvent("oauth_strict_accept_rejected")).toBe(false)
			const serverMetadata = fixture.mcp.hasEvent("oauth_server_metadata_requested", {
				accept: "application/json, text/event-stream",
			})
			expect(serverMetadata).toBe(true)
			const registered = await fixture.mcp.waitForEvent("oauth_client_registered", {
				description: "DCR carried the text/event-stream Accept header",
			})
			expect(registered.accept).toContain("text/event-stream")
			trace.step("discovery GET and DCR POST carried application/json, text/event-stream")

			terminal.submit("Call the OAuth-protected MCP echo tool")
			await waitForText(terminal, "OAuth login succeeded against the spec-strict gateway.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-strict-accept" } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: oauth-strict-accept")
			trace.step("authenticated MCP call through the strict gateway verified")
		},
	)
})
