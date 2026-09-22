import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("a fresh MCP setup offers manual configuration without server presets", async ({ terminal }) => {
	await runKimchiSession(terminal, { artifactName: "mcp-no-presets", responses: [] }, async (fixture, trace) => {
		terminal.write("/mcp")
		await waitForText(terminal, "/mcp")
		terminal.submit("")
		await waitForText(terminal, "No MCP servers configured.")
		trace.step("empty MCP status shows manual configuration guidance")

		terminal.write("/mcp setup")
		await waitForText(terminal, "/mcp setup")
		terminal.submit("")
		await waitForText(terminal, "Kimchi does not include MCP server presets.")
		expect(fullText(terminal)).not.toMatch(/DeepWiki|Context7|Parallel Search|Notion|GitHub|Chrome DevTools/)
		expect(existsSync(join(fixture.workDir, ".mcp.json"))).toBe(false)
		expect(existsSync(join(fixture.homeDir, ".config", "mcp", "mcp.json"))).toBe(false)
		trace.step("explicit setup offers no presets and creates no server configuration")
	})
})
