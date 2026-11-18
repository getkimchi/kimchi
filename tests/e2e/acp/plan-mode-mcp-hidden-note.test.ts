// ACP integration: plan mode advertises the MCP gateway for read-only
// operations and tells the model why write-capable direct tools are absent.

import { afterEach, describe, expect, it } from "vitest"
import { mcpToolResult } from "../tui/support/mcp-fixture.js"
import {
	gatewayMcpCall,
	modelReply,
	requireRequestAdvertisingTool,
	toolResultText,
} from "../tui/support/mcp-model-script.js"
import { type AcpMcpFixture, STARTUP_TIMEOUT_MS, startAcpMcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const NOTE_FRAGMENT = "Plan mode is active: the `mcp` gateway"

const GATEWAY_READ_CASES = [
	{ label: "displayed wire name", toolPrefix: undefined, artifactSuffix: "wire-name" },
	{ label: "upstream original name", toolPrefix: "none" as const, artifactSuffix: "original-name" },
] as const

describe(
	"ACP integration — plan mode MCP note",
	() => {
		let fixture: AcpMcpFixture | undefined

		afterEach(async () => {
			await fixture?.stop()
		})

		it("adds the plan-mode MCP note to the request system prompt", async () => {
			fixture = await startAcpMcpFixture({
				artifactName: "acp-plan-mode-mcp-hidden-note",
				extraArgs: ["--plan"],
				mcp: {
					behavior: {
						catalogTools: [
							{
								name: "get_write_access",
								description: "Change fixture permissions",
								inputSchema: { type: "object", properties: {}, additionalProperties: false },
							},
						],
						tools: [mcpToolResult("get_write_access", { content: [{ type: "text", text: "unused" }] })],
					},
				},
				responses: [{ stream: ["The tool stays hidden while plan mode is on."] }],
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "Plan this change")).stopReason).toBe("end_turn")

			const request = fixture.fake.requests.find((candidate) => candidate.url.startsWith("/openai/v1/chat/completions"))
			expect(request).toBeDefined()
			const body = request?.body as {
				messages?: Array<{ role?: string; content?: unknown }>
				tools?: Array<{ function?: { name?: string } }>
			}
			const system = body.messages?.find((message) => message.role === "system")
			const systemText = typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "")
			expect(systemText).toContain(NOTE_FRAGMENT)
			// The gateway remains available, but its prompt note restricts it to
			// read-only operations while write-capable direct tools stay hidden.
			expect((body.tools ?? []).map((tool) => tool.function?.name)).toContain("mcp")
			expect(systemText).toContain("read-only operations")
		})

		it.each(GATEWAY_READ_CASES)("executes an annotated Jira read using the $label without leaving plan mode", async ({
			toolPrefix,
			artifactSuffix,
		}) => {
			const read = gatewayMcpCall("getJiraIssue", { issueIdOrKey: "LLM-4358" }, { toolPrefix })
			fixture = await startAcpMcpFixture({
				artifactName: `acp-plan-mode-mcp-gateway-read-${artifactSuffix}`,
				extraArgs: ["--plan"],
				mcp: {
					behavior: {
						catalogTools: [
							{
								name: "getJiraIssue",
								description: "Read a Jira issue",
								inputSchema: {
									type: "object",
									properties: { issueIdOrKey: { type: "string" } },
									additionalProperties: false,
								},
								annotations: { readOnlyHint: true },
							},
						],
						tools: [
							mcpToolResult("getJiraIssue", {
								content: [{ type: "text", text: "LLM-4358: Enable MCP access in plan mode" }],
							}),
						],
					},
				},
				responses: [read.response, modelReply("I read LLM-4358 while staying in plan mode.")],
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "Read LLM-4358 to inform the plan")).stopReason).toBe("end_turn")

			requireRequestAdvertisingTool(fixture.fake.requests, "mcp")
			expect(
				fixture.mcp.hasEvent("tool_called", {
					name: "getJiraIssue",
					arguments: { issueIdOrKey: "LLM-4358" },
				}),
			).toBe(true)
			expect(toolResultText(fixture.fake.requests, read)).toContain("LLM-4358: Enable MCP access in plan mode")
		})
	},
	STARTUP_TIMEOUT_MS,
)
