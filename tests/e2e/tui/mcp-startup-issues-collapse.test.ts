import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("MCP startup issues render collapsed by default and expand with ctrl+o", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-startup-issues-collapse",
			responses: [],
			seedHome(homeDir) {
				// A persisted legacy MCP key produces exactly one startup issue.
				const configPath = join(homeDir, ".config", "kimchi", "config.json")
				const config = JSON.parse(readFileSync(configPath, "utf-8"))
				config.mcpSearchLimit = 3
				writeFileSync(configPath, JSON.stringify(config))
			},
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "[1 MCP issue] Some MCP configuration needs attention.")
			expect(fullText(terminal)).toContain("ctrl+o to expand")
			expect(fullText(terminal)).not.toContain("mcpSearchLimit no longer controls")
			trace.step("one collapsed startup-issues line, issue details hidden")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "mcpSearchLimit no longer controls")
			trace.step("ctrl+o expands the full MCP issue list")
		},
	)
})
