import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import { modelReply } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

function writeProjectOverride(workDir: string): void {
	const destination = join(workDir, ".kimchi", "mcp.json")
	mkdirSync(dirname(destination), { recursive: true })
	// Same-name override hides the globally configured server for this project.
	writeFileSync(destination, JSON.stringify({ mcpServers: { fixture: { enabled: false } } }), "utf-8")
}

test("a project .kimchi/mcp.json override hides a same-named global server", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-config-project-override",
			trustWorkDir: false,
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: should-not-run" }] },
							{ message: "should-not-run" },
						),
					],
				},
			},
			responses: [modelReply("I do not see an MCP echo tool available in this project.")],
			seedHome: (_homeDir, workDir) => writeProjectOverride(workDir),
			beforeReady: async (t) => {
				// Trust-gated resources (.kimchi/mcp.json) prompt before startup.
				await waitForText(t, "Trust (this session only)", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
				await delay(250)
				t.submit("")
			},
		},
		async (fixture, trace) => {
			terminal.submit("Call the MCP fixture to echo should-not-run")
			await waitForText(terminal, "I do not see an MCP echo tool available in this project.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const advertised = fixture.fake.requests.flatMap((request) => {
				const tools =
					request.body && typeof request.body === "object" ? (request.body as { tools?: unknown }).tools : undefined
				if (!Array.isArray(tools)) return []
				return tools
					.map((tool) =>
						tool && typeof tool === "object"
							? ((tool as { function?: { name?: string } }).function?.name ?? undefined)
							: undefined,
					)
					.filter((name): name is string => typeof name === "string")
			})
			expect(advertised).not.toContain("mcp__fixture__echo")
			expect(fixture.mcp.hasEvent("tool_called")).toBe(false)
			trace.step("project override kept the same-named global server fully out of the session")
		},
	)
})
