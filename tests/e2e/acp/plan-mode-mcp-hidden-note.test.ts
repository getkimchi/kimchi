// ACP integration: plan mode hides the MCP gateway/tools — the next model
// request must SAY SO on its system prompt instead of letting the model
// report "no MCP tools are accessible" (read by users as an auth failure).

import { afterEach, describe, expect, it } from "vitest"
import { mcpToolResult } from "../tui/support/mcp-fixture.js"
import { type AcpMcpFixture, STARTUP_TIMEOUT_MS, startAcpMcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const NOTE_FRAGMENT = "Plan mode is active: the `mcp` gateway"

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
			// The note and the loadout agree: hidden tools really are absent from
			// the request, so the note is the only way the model learns why.
			expect((body.tools ?? []).map((tool) => tool.function?.name)).not.toContain("mcp")
		})
	},
	STARTUP_TIMEOUT_MS,
)
