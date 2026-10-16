import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mcpToolResult } from "../tui/support/mcp-fixture.js"
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
	it("reports needsAuth from an unauthenticated probe of an OAuth-protected server", async () => {
		const fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-probe-needs-auth",
			mcp: { transport: "oauth" },
			responses: [],
		})
		try {
			const probe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
				server: fixture.mcp.serverDefinition,
				serverName: "protected",
			})
			expect(probe).toMatchObject({ tools: [], needsAuth: true })
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
			// Native engine: the 10s probe abort surfaces as a bounded timeout/abort error.
			expect(probe).toMatchObject({ tools: [], needsAuth: false })
			expect(String(probe.error)).toMatch(/timed out|abort/i)
			expect(performance.now() - started).toBeLessThan(20_000)
			await fixture.mcp.waitForEvent("process_exited", { where: { code: 0 } })
			expect(fixture.mcp.hasEvent("initialized")).toBe(false)
		} finally {
			await fixture.stop()
		}
	}, 25_000)
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
