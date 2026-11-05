import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("negotiates the MCP 2026-07-28 era with a stateless server and completes an MRTR elicitation round", async ({
	terminal,
}) => {
	const echo = gatewayMcpCall("echo", { message: "modern-era" })
	const confirmCall = gatewayMcpCall("confirm_delete", { file: "notes.txt" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-modern",
			mcp: {
				transport: "modern-http",
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: modern-era" }] },
							{ message: "modern-era" },
						),
					],
					mrtr: {
						name: "confirm_delete",
						message: "Are you sure you want to delete notes.txt?",
						result: { content: [{ type: "text", text: "deleted notes.txt (confirmed)" }] },
					},
				},
			},
			responses: [
				echo.response,
				modelReply("Echo round-tripped over the modern MCP era."),
				confirmCall.response,
				modelReply("The MCP server confirmed the deletion."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Call the MCP fixture echo tool")
			await waitForText(terminal, "Echo round-tripped over the modern MCP era.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			await fixture.mcp.waitForEvent("modern_discover_served")
			expect(fixture.mcp.hasEvent("modern_request", { protocolVersion: "2026-07-28" })).toBe(true)
			// Negotiation must win over the legacy handshake: a modern-only server
			// never sees an initialize from an auto-negotiating client.
			expect(fixture.mcp.hasEvent("modern_initialize_rejected")).toBe(false)
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: modern-era")
			trace.step("2026-07-28 negotiation verified: server/discover served and _meta stamped")

			// MRTR: the call pauses for an elicitation round. The adapter surfaces
			// the confirm flow as three sequential TUI selects (continue, boolean
			// field, review); every default option is the accepting one.
			terminal.submit("Ask the MCP server to delete notes.txt")
			await waitForText(terminal, "MCP Input Request", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Confirm to continue", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Submit", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			terminal.submit("")

			await waitForText(terminal, "The MCP server confirmed the deletion.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("modern_tool_input_required", {
				where: { name: "confirm_delete" },
			})
			await fixture.mcp.waitForEvent("modern_tool_completed", {
				where: { name: "confirm_delete", requestStateVerified: true },
			})
			expect(toolResultText(fixture.fake.requests, confirmCall)).toContain("deleted notes.txt (confirmed)")
			trace.step("MRTR elicitation round completed: input_required answered and requestState echoed")
		},
	)
})
