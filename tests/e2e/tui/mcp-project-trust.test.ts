import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, test } from "@microsoft/tui-test"
import { fullText, STARTUP_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function moveFixtureToProject(homeDir: string, workDir: string): void {
	const source = join(homeDir, ".config", "kimchi", "harness", "mcp.json")
	const destination = join(workDir, ".mcp.json")
	mkdirSync(dirname(destination), { recursive: true })
	renameSync(source, destination)
}

test("does not execute an untrusted repository MCP server during startup", async ({ terminal }) => {
	let sentinel = ""
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-project-trust-denied",
			responses: [],
			seedHome: (_homeDir, workDir) => {
				sentinel = join(workDir, "project-mcp-started")
				writeFileSync(
					join(workDir, ".mcp.json"),
					JSON.stringify({
						mcpServers: {
							untrusted: {
								command: process.execPath,
								args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "started")`],
							},
						},
					}),
				)
			},
			beforeReady: async (t) => {
				await waitForText(t, "Trust project MCP configuration?", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
				expect(existsSync(sentinel)).toBe(false)
				t.keyDown(2)
				t.submit("")
			},
		},
		async (_fixture, trace) => {
			await delay(500)
			expect(existsSync(sentinel)).toBe(false)
			// The denial warning is one entry in the collapsed MCP startup-issues
			// row. Match count-agnostically ("MCP issue" without the "[1" prefix):
			// other startup issues can legitimately share the row.
			await waitForText(terminal, "MCP issue")
			await waitForText(terminal, "needs attention")
			expect(fullText(terminal)).toContain("ctrl+o to expand")
			expect(fullText(terminal)).not.toContain("Project MCP configuration is not trusted")
			trace.step("collapsed MCP issues row rendered, trust warning hidden")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "Project MCP configuration is not trusted")
			trace.step("trust warning visible after expand; repository MCP process remained stopped")
		},
	)
})

test("starts a repository MCP server after the user trusts the project", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-project-trust-accepted",
			mcp: {},
			responses: [],
			seedHome: moveFixtureToProject,
			beforeReady: async (t) => {
				await waitForText(t, "Trust project MCP configuration?", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
				t.submit("")
			},
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("initialized", {
				description: "trusted repository MCP server initialization",
			})
			trace.step("trusted repository MCP server initialized normally")
		},
	)
})
