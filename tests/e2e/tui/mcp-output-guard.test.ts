import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

// Over 20 KB: under the adapter's old 50 KB default (which passed it through
// untruncated) and well over the new 12 KB default (which must truncate +
// spill). ASCII only, so string length equals the byte count the guard
// measures.
function bigReport(): string {
	const lines: string[] = []
	for (let i = 0; i < 100; i++) {
		lines.push(
			`{"row": ${i}, "cluster": "prod-aws-region-${i}", "cost": ${(i * 1.5).toFixed(2)}, "note": "${"x".repeat(200)}"}`,
		)
	}
	return lines.join("\n")
}

test("truncates an oversized MCP tool result at the 12 KB default and spills the full text", async ({ terminal }) => {
	const report = bigReport()
	expect(report.length).toBeGreaterThan(12 * 1024)
	expect(report.length).toBeLessThan(50 * 1024)

	const call = gatewayMcpCall("big_report")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-output-guard",
			mcp: {
				behavior: {
					catalogTools: [{ name: "big_report", inputSchema: { type: "object", properties: {} } }],
					tools: [mcpToolResult("big_report", { content: [{ type: "text", text: report }] })],
				},
			},
			responses: [call.response, modelReply("The oversized MCP report was truncated and spilled to a file.")],
		},
		async (fixture, trace) => {
			terminal.submit("Pull the big cost report from the MCP fixture")

			await waitForText(terminal, "The oversized MCP report was truncated and spilled to a file.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("final response visible after oversized MCP tool result")

			const modelFacing = toolResultText(fixture.fake.requests, call)
			expect(modelFacing).toContain("[MCP text output truncated")
			expect(modelFacing).toContain("12.0KB limit")
			expect(modelFacing).toContain("Full text saved to:")
			expect(modelFacing).toContain("use read with offset/limit or grep to inspect")
			expect(modelFacing.length).toBeLessThan(report.length)
			expect(modelFacing.length).toBeGreaterThan(8 * 1024)
			trace.step("model-facing result truncated at 12 KB with spill pointer")
		},
	)
})
