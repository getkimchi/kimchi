import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MCP_FIXTURE_OAUTH_ACCESS_TOKEN, mcpToolResult } from "../tui/support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "../tui/support/mcp-model-script.js"
import { type AcpMcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture, startAcpMcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — MCP", () => {
	let fixture: AcpMcpFixture
	const echo = gatewayMcpCall("echo", { message: "acp-mcp" })
	const mixedContent = gatewayMcpCall("mixed_content")

	beforeEach(async () => {
		fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-workflow",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: acp-mcp" }] },
							{ message: "acp-mcp" },
						),
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

	it("discovers all original tools even when the configured model surface selects only echo", async () => {
		const probe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
			server: { ...fixture.mcp.serverDefinition, includeTools: ["echo"] },
			serverName: "acp-fixture-probe",
		})
		expect(probe).toMatchObject({ needsAuth: false, error: null })
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

describe("ACP integration — probe recovery", () => {
	it("migrates preauthorized legacy credentials before the first probe, without a session", async () => {
		const fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-legacy-probe",
			mcp: { transport: "oauth", oauthPreauthorized: true },
			responses: [],
		})
		try {
			const legacyDir = join(fixture.homeDir, ".config", "kimchi", "harness", "mcp-oauth", "fixture")
			mkdirSync(legacyDir, { recursive: true })
			writeFileSync(
				join(legacyDir, "tokens.json"),
				JSON.stringify({ serverUrl: fixture.mcp.url, tokens: { accessToken: MCP_FIXTURE_OAUTH_ACCESS_TOKEN } }),
				{ mode: 0o600 },
			)
			const probe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
				server: fixture.mcp.serverDefinition,
				serverName: "fixture",
				skipAuth: true,
			})
			expect(probe).toMatchObject({ needsAuth: false, error: null })
			expect(probe.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "echo" })]))
			expect(fixture.mcp.hasEvent("oauth_browser_opened")).toBe(false)
		} finally {
			await fixture.stop()
		}
	})

	it("ends a stalled stdio probe within its total deadline and stops the child process", async () => {
		const fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-probe-deadline",
			mcp: { behavior: { startup: { type: "hang" } } },
			responses: [],
		})
		try {
			const started = performance.now()
			const probe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
				server: fixture.mcp.serverDefinition,
				serverName: "stalled",
			})
			expect(probe).toEqual({ tools: [], needsAuth: false, error: "Probe timed out after 15 seconds" })
			expect(performance.now() - started).toBeLessThan(20_000)
			await fixture.mcp.waitForEvent("process_exited", { where: { code: 0 } })
			expect(fixture.mcp.hasEvent("initialized")).toBe(false)
		} finally {
			await fixture.stop()
		}
	}, 25_000)
})

describe("ACP integration — OAuth MCP", () => {
	let fixture: AcpMcpFixture
	const echo = gatewayMcpCall("echo", { message: "acp-oauth-mcp" })

	beforeEach(async () => {
		fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-oauth-workflow",
			mcp: {
				transport: "oauth",
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: acp-oauth-mcp" }] },
							{ message: "acp-oauth-mcp" },
						),
					],
				},
			},
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

describe("ACP integration — OAuth MCP with a remote https redirect", () => {
	let fixture: AcpMcpFixture
	const echo = gatewayMcpCall("echo", { message: "acp-oauth-remote-redirect" })

	beforeEach(async () => {
		fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-oauth-remote-redirect",
			mcp: {
				transport: "oauth",
				oauth: { redirectUri: "https://app.kimchi.dev/mcp-oauth/callback-v2" },
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: acp-oauth-remote-redirect" }] },
							{ message: "acp-oauth-remote-redirect" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("ACP used the OAuth-protected MCP tool after the remote redirect.")],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("authenticates through the loopback bounce without a manual paste", async () => {
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
		expect(authenticatedProbe.error).toBeNull()
		expect(authenticatedProbe.needsAuth).toBe(false)
		expect(authenticatedProbe.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "echo" })]))

		await fixture.mcp.waitForEvent("oauth_authorized", {
			where: { redirectUri: "https://app.kimchi.dev/mcp-oauth/callback-v2" },
		})
		await fixture.mcp.waitForEvent("oauth_token_issued", { where: { grantType: "authorization_code" } })
		expect(fixture.mcp.hasEvent("oauth_browser_completed")).toBe(true)

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Call the OAuth-protected configured MCP tool")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("ACP used the OAuth-protected MCP tool after the remote redirect.")
		await fixture.mcp.waitForEvent("tool_called", {
			where: { name: "echo", arguments: { message: "acp-oauth-remote-redirect" } },
		})
		expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: acp-oauth-remote-redirect")
	})
})

describe("ACP integration — project MCP trust", () => {
	it(
		"does not execute repository MCP configuration in a headless session without trust",
		async () => {
			const fixture = await startAcpFixture({ artifactName: "acp-mcp-project-trust", responses: [] })
			try {
				const sentinel = join(fixture.workDir, "project-mcp-started")
				writeFileSync(
					join(fixture.workDir, ".mcp.json"),
					JSON.stringify({
						mcpServers: {
							untrusted: {
								command: process.execPath,
								args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "started")`],
							},
						},
					}),
				)

				await newSession(fixture, fixture.workDir)
				await delay(500)

				expect(existsSync(sentinel)).toBe(false)
			} finally {
				await fixture.stop()
			}
		},
		STARTUP_TIMEOUT_MS,
	)
})

describe("ACP integration — OAuth MCP re-auth in a live session", () => {
	it("heals a live session after probe-driven re-auth; a fresh session also works", async () => {
		const beforeRevocation = gatewayMcpCall("echo", { message: "acp-before-revocation" })
		const revokeCall = gatewayMcpCall("revoke_auth")
		const whileRevoked = gatewayMcpCall("echo", { message: "acp-while-revoked" })
		const afterProbeAuth = gatewayMcpCall("echo", { message: "acp-after-probe-auth" })
		const freshSessionCall = gatewayMcpCall("echo", { message: "acp-fresh-session" })
		const fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-reauth-session",
			mcp: {
				transport: "oauth",
				scenario: "oauth-manual-revoke",
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: acp-before-revocation" }] },
							{ message: "acp-before-revocation" },
						),
						mcpToolResult("revoke_auth", { content: [{ type: "text", text: "fixture: access revoked" }] }),
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: acp-while-revoked" }] },
							{ message: "acp-while-revoked" },
						),
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: acp-after-probe-auth" }] },
							{ message: "acp-after-probe-auth" },
						),
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: acp-fresh-session" }] },
							{ message: "acp-fresh-session" },
						),
					],
				},
			},
			responses: [
				beforeRevocation.response,
				modelReply("Authenticated call worked."),
				revokeCall.response,
				modelReply("Access revoked."),
				whileRevoked.response,
				modelReply("Re-authentication is now required."),
				afterProbeAuth.response,
				modelReply("Recovered after probe re-auth."),
				freshSessionCall.response,
				modelReply("Fresh session works."),
			],
		})
		try {
			// Studio's MCP settings UI authenticates the server through the
			// isolated probe before any chat session exists.
			const server = fixture.mcp.serverDefinition
			const probe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", { server, serverName: "fixture" })
			expect(probe).toMatchObject({ needsAuth: false, error: null })
			const initialToken = await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code" },
			})

			const sessionId = await newSession(fixture, fixture.workDir)
			const ok = await prompt(fixture, sessionId, "Call the protected MCP tool")
			expect(ok.chunks).toContain("Authenticated call worked.")
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "acp-before-revocation" } },
			})
			expect(toolResultText(fixture.fake.requests, beforeRevocation)).toContain("fixture echo: acp-before-revocation")

			const revoked = await prompt(fixture, sessionId, "Revoke the MCP access token")
			expect(revoked.chunks).toContain("Access revoked.")
			await fixture.mcp.waitForEvent("oauth_manual_revoke")

			const whileDown = await prompt(fixture, sessionId, "Call the protected MCP tool after revocation")
			expect(whileDown.chunks).toContain("Re-authentication is now required.")
			await fixture.mcp.waitForEvent("oauth_refresh_rejected")
			expect(fixture.mcp.hasEvent("tool_called", { name: "echo", arguments: { message: "acp-while-revoked" } })).toBe(
				false,
			)
			expect(toolResultText(fixture.fake.requests, whileRevoked)).toMatch(/auth|401|unauthorized|log ?in/i)

			// Re-auth the way Studio does: the isolated probe authenticates and
			// reports tools — without telling the live session anything.
			const reauthProbe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
				server,
				serverName: "fixture",
				authenticate: true,
			})
			expect(reauthProbe).toMatchObject({ needsAuth: false, error: null })
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				predicate: (event: { grantType: string; at: string }) =>
					event.grantType === "authorization_code" && Date.parse(event.at) > Date.parse(initialToken.at),
			})

			// The reported bug's decisive moment: the LIVE session has just been
			// given a fresh credential through the shared store. Its next tool
			// call must heal itself: the revoked token 401s, session recovery
			// reconnects, and the reconnect re-reads the fresh credential.
			const recovered = await prompt(fixture, sessionId, "Call the protected MCP tool after re-authenticating")
			expect(recovered.chunks).toContain("Recovered after probe re-auth.")
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "acp-after-probe-auth" } },
			})
			expect(toolResultText(fixture.fake.requests, afterProbeAuth)).toContain("fixture echo: acp-after-probe-auth")
			// Healing is a reconnect over a fresh HTTP session (probe + original
			// session + re-auth probe + recovery reconnect) with no interactive
			// auth flow beyond the two probes.
			expect(fixture.mcp.eventsOfType("http_session_initialized").length).toBe(4)
			expect(fixture.mcp.eventsOfType("oauth_browser_opened").length).toBe(2)

			// A new session — the reporter's workaround — picks up the credential.
			const freshSessionId = await newSession(fixture, fixture.workDir)
			const fresh = await prompt(fixture, freshSessionId, "Call the protected MCP tool in a fresh session")
			expect(fresh.chunks).toContain("Fresh session works.")
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "acp-fresh-session" } },
			})
			expect(toolResultText(fixture.fake.requests, freshSessionCall)).toContain("fixture echo: acp-fresh-session")
		} finally {
			await fixture.stop()
		}
	}, 30_000)
})
