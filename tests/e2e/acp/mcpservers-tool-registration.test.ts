// ACP integration: verifies caller-supplied mcpServers are actually connected
// and their tools become available to the agent during a prompt turn.
//
// The test passes a real stdio MCP server (a simple Node script that responds
// to MCP `tools/list` with one tool "echo") via session/new, then prompts the
// agent and asserts that:
//   1. The MCP server's tool appears in a tool_call_start session update
//   2. The agent references the tool by its prefixed name
//
// This proves the full pipeline: ACP params → conversion → registry →
// initializeMcp → McpServerManager.connect → tool metadata → agent prompt.

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"

// A minimal MCP server script that responds to `initialize` and `tools/list`.
// Exposes one tool: "echo" (echoes the input text).
const MCP_SERVER_SCRIPT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });

const tools = [{
  name: "echo",
  description: "Echoes back the input text",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }
}];

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const resp = { jsonrpc: "2.0", id: msg.id };
  if (msg.method === "initialize") {
    resp.result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "echo-mcp", version: "1.0.0" } };
  } else if (msg.method === "tools/list") {
    resp.result = { tools };
  } else if (msg.method === "tools/call") {
    resp.result = { content: [{ type: "text", text: "echo: " + (JSON.parse(msg.params.arguments).text || "") }] };
  } else if (msg.method === "notifications/initialized") {
    return; // notification, no response
  } else {
    resp.result = {};
  }
  process.stdout.write(JSON.stringify(resp) + "\\n");
});
`

describe("ACP integration — mcpServers tool registration", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "mcpservers-tool-registration",
			// Turn 1: agent calls the echo tool, then finishes.
			responses: [
				{
					stream: ["Let me echo that."],
					toolCalls: [
						{
							function: {
								name: "echo_mcp_echo",
								arguments: JSON.stringify({ text: "hello from ACP" }),
							},
						},
					],
				},
				{ stream: ["done"] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("connects caller-supplied MCP server and exposes its tools to the agent", async () => {
		// Write the MCP server script to the workdir
		const mcpScriptPath = join(fixture.workDir, "echo-mcp.js")
		writeFileSync(mcpScriptPath, MCP_SERVER_SCRIPT, "utf-8")

		// Create a session with the MCP server attached
		const res = await fixture.conn.newSession({
			cwd: fixture.workDir,
			mcpServers: [
				{
					name: "echo_mcp",
					command: process.execPath,
					args: [mcpScriptPath],
					env: [],
				},
			],
		})
		expect(res.sessionId).toBeTruthy()

		// Give initializeMcp time to connect to the MCP server (it's async).
		// The session_start → initializeMcp → connect pipeline is fire-and-forget,
		// so we wait for the tool to appear in a prompt turn's tool_call updates.
		const promptResult = fixture.conn.prompt({
			sessionId: res.sessionId,
			prompt: [{ type: "text", text: "Use the echo tool to echo 'hello from ACP'" }],
		})

		// Race against timeout
		const result = await Promise.race([
			promptResult,
			new Promise<{ stopReason: string }>((resolve) => setTimeout(() => resolve({ stopReason: "TIMEOUT" }), 30_000)),
		])

		// The prompt should complete (not timeout)
		expect((result as { stopReason: string }).stopReason).not.toBe("TIMEOUT")

		// Verify the MCP tool appeared in session updates. The tool_call
		// update carries a `title` field with the prefixed tool name.
		const toolCallUpdates = fixture.client.sessionUpdates.filter(
			(u) => u.update.sessionUpdate === "tool_call" && u.sessionId === res.sessionId,
		)

		expect(toolCallUpdates.length).toBeGreaterThan(0)
		const toolCall = toolCallUpdates[0].update as unknown as {
			title?: string
			toolCallId?: string
			sessionUpdate: string
		}
		// The tool name should contain "echo" (prefixed with the server name)
		expect(toolCall.title).toMatch(/echo/)
	})
})
