import { afterEach, describe, expect, it } from "vitest"
import { mcpToolResult } from "../tui/support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "../tui/support/mcp-model-script.js"
import { type AcpMcpFixture, STARTUP_TIMEOUT_MS, startAcpMcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — MCP 2026-07-28 (modern era)", () => {
	// Each test owns its fixture: unique server name (own event log + config
	// entry) and an explicit stop before the next fixture starts, so a
	// slow-dying binary from one test cannot reconnect into the next test's
	// rewritten shared mcp.json.
	let fixture: AcpMcpFixture | undefined

	async function stopFixture(): Promise<void> {
		await fixture?.stop()
		fixture = undefined
	}

	afterEach(async () => {
		await stopFixture()
	})

	it(
		"probes a stateless 2026-07-28 server through the real ACP process",
		async () => {
			await stopFixture()
			fixture = await startAcpMcpFixture({
				artifactName: "acp-mcp-modern-probe",
				mcp: {
					serverName: "acp-modern-probe",
					transport: "modern-http",
					behavior: {
						tools: [
							mcpToolResult(
								"echo",
								{ content: [{ type: "text", text: "fixture echo: acp-modern" }] },
								{ message: "acp-modern" },
							),
						],
						mrtr: {
							name: "confirm_delete",
							message: "Are you sure you want to delete notes.txt?",
							result: { content: [{ type: "text", text: "deleted notes.txt (confirmed)" }] },
						},
					},
				},
				responses: [],
			})

			const probe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
				server: fixture.mcp.serverDefinition,
				serverName: "acp-modern-probe",
			})
			expect(probe.needsAuth).toBe(false)
			expect(probe.error).toBeNull()
			expect(probe.tools).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "echo" }),
					expect.objectContaining({ name: "confirm_delete" }),
				]),
			)
			await fixture.mcp.waitForEvent("modern_discover_served")
			expect(fixture.mcp.hasEvent("modern_request", { protocolVersion: "2026-07-28" })).toBe(true)
		},
		STARTUP_TIMEOUT_MS,
	)

	it(
		"completes an MRTR elicitation round across the ACP boundary",
		async () => {
			await stopFixture()
			const confirmCall = gatewayMcpCall("confirm_delete", { file: "notes.txt" }, { serverName: "acp-modern-mrtr" })
			fixture = await startAcpMcpFixture({
				artifactName: "acp-mcp-modern-mrtr",
				mcp: {
					serverName: "acp-modern-mrtr",
					transport: "modern-http",
					behavior: {
						mrtr: {
							name: "confirm_delete",
							message: "Are you sure you want to delete notes.txt?",
							result: { content: [{ type: "text", text: "deleted notes.txt (confirmed)" }] },
						},
					},
				},
				responses: [confirmCall.response, modelReply("ACP completed the confirmed MCP deletion.")],
			})

			const sessionId = await newSession(fixture, fixture.workDir)
			const result = await prompt(fixture, sessionId, "Ask the MCP fixture to delete notes.txt")
			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain("ACP completed the confirmed MCP deletion.")

			await fixture.mcp.waitForEvent("modern_tool_input_required", {
				where: { name: "confirm_delete" },
			})
			await fixture.mcp.waitForEvent("modern_tool_completed", {
				where: { name: "confirm_delete", requestStateVerified: true },
			})
			expect(toolResultText(fixture.fake.requests, confirmCall)).toContain("deleted notes.txt (confirmed)")
		},
		STARTUP_TIMEOUT_MS,
	)

	it(
		"keeps an explicitly pinned legacy entry on the legacy handshake against a modern-only server",
		async () => {
			// The safety property of the default flip: an explicit per-entry
			// protocolVersion always wins over the host default. A legacy-pinned entry
			// against a modern-only server must attempt the initialize handshake (and
			// be rejected by it), never negotiate.
			await stopFixture()
			fixture = await startAcpMcpFixture({
				artifactName: "acp-mcp-modern-legacy-pin",
				mcp: {
					serverName: "acp-modern-legacy-pin",
					transport: "modern-http",
					behavior: {},
				},
				responses: [],
			})

			const probe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
				server: { ...fixture.mcp.serverDefinition, protocolVersion: "legacy" },
				serverName: "acp-modern-legacy-pin",
			})
			expect(probe.error).not.toBeNull()
			expect(probe.tools).toEqual([])
			// The rejected handshake is the probe's pinned-legacy initialize; the
			// session-level connection (host default) still negotiates and is
			// asserted separately by the probe test above.
			await fixture.mcp.waitForEvent("modern_initialize_rejected")
		},
		STARTUP_TIMEOUT_MS,
	)

	it(
		"keeps legacy-era servers reachable when the fixture speaks 2025",
		async () => {
			// The remaining mcp-* ACP suite exercises legacy servers through the same
			// default configuration; this leg pins the era fallback on the new
			// plumbing: a plain 2025-era fixture still handshakes (initialize accepted)
			// because auto negotiation falls back when no modern evidence exists.
			await stopFixture()
			const echo = gatewayMcpCall("echo", { message: "legacy-fallback" }, { serverName: "acp-legacy-fallback" })
			fixture = await startAcpMcpFixture({
				artifactName: "acp-mcp-modern-legacy-fallback",
				mcp: {
					serverName: "acp-legacy-fallback",
					transport: "http",
					behavior: {
						tools: [
							mcpToolResult(
								"echo",
								{ content: [{ type: "text", text: "fixture echo: legacy-fallback" }] },
								{ message: "legacy-fallback" },
							),
						],
					},
				},
				responses: [echo.response, modelReply("ACP reached the legacy MCP server through the default configuration.")],
			})

			const sessionId = await newSession(fixture, fixture.workDir)
			const result = await prompt(fixture, sessionId, "Call the configured MCP fixture echo tool")
			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain("ACP reached the legacy MCP server through the default configuration.")
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "legacy-fallback" } },
			})
		},
		STARTUP_TIMEOUT_MS,
	)
})
