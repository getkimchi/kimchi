import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { modelReply, requireRequestAdvertisingTool, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("shows the Kimchi-branded browser page after MCP OAuth authorization", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-browser-branding",
			mcp: { transport: "oauth" },
			responses: [],
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("http_unauthorized", {
				description: "initial OAuth challenge",
			})

			terminal.submit("/mcp-auth fixture")
			const browser = await fixture.mcp.waitForEvent("oauth_browser_completed", {
				description: "browser loaded the OAuth callback page",
			})

			expect(browser.status).toBe(200)
			expect(browser.hasKimchiBranding).toBe(true)
			expect(browser.hasMcpSuccessCopy).toBe(true)
			expect(browser.hasGenericAdapterBadge).toBe(false)
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
			})
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("browser displayed the Kimchi-branded MCP authorization result")
		},
	)
})

test("shows the Kimchi-branded browser page when MCP OAuth is denied", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-denial-branding",
			mcp: { transport: "oauth", scenario: "oauth-deny" },
			responses: [],
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("http_unauthorized", {
				description: "initial OAuth challenge",
			})

			terminal.submit("/mcp-auth fixture")
			const browser = await fixture.mcp.waitForEvent("oauth_browser_completed", {
				description: "browser loaded the denied OAuth callback page",
			})

			expect(browser.status).toBe(200)
			expect(browser.hasKimchiBranding).toBe(true)
			expect(browser.hasMcpErrorCopy).toBe(true)
			expect(browser.hasGenericAdapterBadge).toBe(false)
			await fixture.mcp.waitForEvent("oauth_authorization_denied")
			await waitForText(terminal, 'Failed to authenticate "fixture": fixture authorization denied', {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("browser displayed the Kimchi-branded MCP authorization failure")
		},
	)
})

test("uses Kimchi product language in MCP setup", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-setup-branding",
			mcp: {},
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.submit("/mcp setup")
			await waitForText(terminal, "Kimchi-owned", { timeoutMs: STREAM_TIMEOUT_MS })

			expect(fullText(terminal)).not.toContain("Pi-owned")
			trace.step("MCP setup rendered Kimchi-owned configuration language")
			terminal.keyEscape()
		},
	)
})

test("advertises a truthful Kimchi-branded MCP gateway to the model", async ({ terminal }) => {
	const nativeToolCallId = "call_mcp_native_tool_branding"
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-model-contract-branding",
			mcp: {},
			responses: [
				{
					toolCalls: [
						{
							id: nativeToolCallId,
							function: { name: "mcp", arguments: JSON.stringify({ tool: "read" }) },
						},
					],
				},
				modelReply("The MCP contract is visible."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Inspect the available MCP tools")
			await waitForText(terminal, "The MCP contract is visible.", { timeoutMs: STREAM_TIMEOUT_MS })

			const request = requireRequestAdvertisingTool(fixture.fake.requests, "mcp")
			const tools =
				(request.body as { tools?: Array<{ function?: { name?: string; description?: string } }> }).tools ?? []
			const gateway = tools.find((tool) => tool.function?.name === "mcp")
			expect(gateway?.function?.description).toContain("Non-MCP Kimchi tools")
			expect(gateway?.function?.description).not.toContain("mcpScript")
			expect(tools.some((tool) => tool.function?.name === "mcpScript")).toBe(false)
			const adapterResult = toolResultText(fixture.fake.requests, nativeToolCallId)
			expect(adapterResult).toContain("native Kimchi tool")
			expect(adapterResult).not.toContain("native Pi tool")
			trace.step("model received a gateway description matching Kimchi's actual tool surface")
		},
	)
})
