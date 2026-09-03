import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { gatewayMcpCall, modelReply, toolResultText } from "../tui/support/mcp-model-script.js"
import { type AcpMcpFixture, STARTUP_TIMEOUT_MS, startAcpMcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — MCP", () => {
	let fixture: AcpMcpFixture
	const echo = gatewayMcpCall("echo", { message: "acp-mcp" })
	const mixedContent = gatewayMcpCall("mixed_content")

	beforeEach(async () => {
		fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-workflow",
			mcp: {},
			modelInput: ["text", "image"],
			responses: [
				echo.response,
				modelReply("ACP received the MCP fixture result."),
				mixedContent.response,
				modelReply("ACP preserved the MCP image result."),
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("probes a configured MCP server through the real ACP process", async () => {
		const probe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
			server: fixture.mcp.serverDefinition,
			serverName: "acp-fixture-probe",
		})
		expect(probe.needsAuth).toBe(false)
		expect(probe.error).toBeNull()
		expect(probe.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "echo" }), expect.objectContaining({ name: "fail" })]),
		)
	})

	it("forwards MCP text and image results across the ACP and model boundaries", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Call the configured MCP fixture echo tool")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("ACP received the MCP fixture result.")

		const completedToolUpdate = fixture.client.sessionUpdates.find(
			(update) =>
				update.sessionId === sessionId &&
				update.update.sessionUpdate === "tool_call_update" &&
				update.update.status === "completed",
		)
		expect(completedToolUpdate).toBeDefined()
		await fixture.mcp.waitForEvent("tool_called", {
			where: { name: "echo", arguments: { message: "acp-mcp" } },
		})
		expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: acp-mcp")

		const imageResult = await prompt(fixture, sessionId, "Request mixed image content from the configured MCP fixture")
		expect(imageResult.stopReason).toBe("end_turn")
		expect(imageResult.chunks).toContain("ACP preserved the MCP image result.")
		const imageToolUpdate = fixture.client.sessionUpdates.find(
			(update) =>
				update.sessionId === sessionId &&
				update.update.sessionUpdate === "tool_call_update" &&
				update.update.content?.some(
					(item) =>
						item.type === "content" &&
						item.content.type === "image" &&
						item.content.data.startsWith("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"),
				),
		)
		expect(imageToolUpdate).toBeDefined()
		await fixture.mcp.waitForEvent("tool_called", { where: { name: "mixed_content", arguments: {} } })
		expect(toolResultText(fixture.fake.requests, mixedContent)).toContain("fixture mixed content: kimchi-mcp-mixed")
	})
})

describe("ACP integration — OAuth MCP", () => {
	let fixture: AcpMcpFixture
	const echo = gatewayMcpCall("echo", { message: "acp-oauth-mcp" })

	beforeEach(async () => {
		fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-oauth-workflow",
			mcp: { transport: "oauth" },
			responses: [echo.response, modelReply("ACP called the OAuth-protected MCP tool.")],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("distinguishes auth-required probing, authenticates, and then uses the protected tool", async () => {
		const server = fixture.mcp.serverDefinition
		const unauthenticatedProbe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
			server,
			serverName: "fixture",
			skipAuth: true,
		})
		expect(unauthenticatedProbe.needsAuth).toBe(true)

		const authenticatedProbe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
			server,
			serverName: "fixture",
		})
		expect(authenticatedProbe.needsAuth).toBe(false)
		expect(authenticatedProbe.error).toBeNull()
		expect(authenticatedProbe.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "echo" })]))
		await fixture.mcp.waitForEvent("oauth_token_issued", { where: { grantType: "authorization_code" } })

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Call the OAuth-protected configured MCP tool")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("ACP called the OAuth-protected MCP tool.")
		await fixture.mcp.waitForEvent("tool_called", {
			where: { name: "echo", arguments: { message: "acp-oauth-mcp" } },
		})
		expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: acp-oauth-mcp")
	})
})
